/**
 * Connection to a single server: enrollment, announcement, the command loop.
 *
 * State is kept per URL: epoch, token. Reconnect uses an exponential pause, but without
 * losing the token already obtained. There is no cursor: the server hands out from the
 * head of the queue, and all the client reports is `max_commandno` — the highest number
 * it has executed.
 *
 * @module dsh-node-client/runner
 */
import * as api from './api.mjs'
import { runBash } from './bash.mjs'
import { adoptCommandno } from './commandno.mjs'
import { preciseNow } from './shell.mjs'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeUrl } from './config.mjs'
import { home, openStore } from './store.mjs'
import { openPresence } from './presence.mjs'
import { classify, DSH_MODES, MODES, narrower, profileArgs, probe } from './sandbox.mjs'
import { createSessionStore } from './sessions.mjs'
import { askLocally } from './approver.mjs'
import { apisOf, loadPlugins, resolvePlugin, rulesOf } from './plugins/index.mjs'
import { abortAllApprovals } from './approve-command.mjs'
import { t } from './i18n.mjs'

/**
 * A pause that respects cancellation.
 *
 * The listener is removed in finally: the daemon lives for days and pauses once every
 * few seconds. Otherwise a single AbortSignal accumulates thousands of listeners —
 * that is both the MaxListenersExceeded warning and growing memory.
 */
/** Exit code from a command result: the client puts it in the last block. */
export function codeOf (outcome) {
  const blocks = Array.isArray(outcome?.results) ? outcome.results : []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = blocks[i]?.text
    if (typeof text !== 'string' || !text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.code === 'number') return parsed.code
    } catch {}
  }
  return null
}

/**
 * Executor pool with a cap on simultaneous commands.
 *
 * Why a pool and not "a batch + Promise.all": while the client waits for the whole
 * batch it does not pick up new commands, and `#INTERNAL.CANCEL`, issued by the server
 * in the middle of a long command, stands in the queue until its end — there is
 * nothing to cancel with.
 *
 * The pool answers three questions: how many slots are busy (`busy`) and free
 * (`free`), when at least one becomes free (`whenFree`) and when the whole pool is
 * empty (`whenIdle`). The last one is needed by the `#INTERNAL.FLUSH` barrier: its
 * meaning is "everything that was before me has finished".
 *
 * @param {{slots?: number, run: (command: object) => Promise<unknown>}} options
 */
export function createPool ({ slots = 5, run }) {
  const limit = Math.max(1, Number(slots) || 1)
  const active = new Set()
  const queue = []
  const idleWaiters = new Set()
  let busy = 0

  const start = (command) => {
    busy += 1
    const task = Promise.resolve()
      .then(() => run(command))
      .catch(() => {})
      .finally(() => {
        active.delete(task)
        busy -= 1
        pump()
        // wake everyone waiting: each checks for itself whether the freed slot is enough
        // (the barrier waits for all except itself, so the condition "busy === 0" does
        // not fit). Only the one whose condition was met removes itself from the set:
        // `clear()` here would drop the wait of those for whom it is still too early.
        for (const waiter of [...idleWaiters]) waiter()
      })
    active.add(task)
    return task
  }

  // everything that did not fit into the slots waits here and starts in issue order
  const pump = () => {
    while (queue.length && busy < limit) {
      const item = queue.shift()
      item.resolve(start(item.command))
    }
  }

  return {
    get busy () { return busy },
    get free () { return Math.max(0, limit - busy) },
    get queued () { return queue.length },
    /**
     * Execute a command by taking a slot. If there are no slots — the command waits
     * here (the caller does not take more from the server than fits anyway, so the
     * queue is short and to the point).
     */
    submit (command) {
      if (busy < limit && queue.length === 0) return start(command)
      return new Promise((resolve) => { queue.push({ command, resolve }) })
    },
    /** Wait until at least one slot is free. */
    whenFree () {
      return active.size ? Promise.race([...active]) : Promise.resolve()
    },
    /** Wait for an empty pool: nothing running and nothing queued. */
    /**
     * Wait for an empty pool — with a caveat: `reserve` busy slots count as "one's
     * own". The `#INTERNAL.FLUSH` barrier takes a slot like an ordinary command, and
     * what it has to wait for is everybody **except itself**: otherwise it waits for
     * itself, and the node stalls until the server-side barrier timeout.
     *
     * @param {number} [reserve] how many busy slots to count as its own
     */
    whenIdle (reserve = 0) {
      const done = () => busy <= reserve && queue.length === 0
      return done()
        ? Promise.resolve()
        : new Promise((resolve) => {
          // wait for an event and re-check: "a slot was freed" and "the pool is empty for
          // me" are different conditions
          const waiter = () => {
            if (!done()) return
            idleWaiters.delete(waiter)
            resolve()
          }
          idleWaiters.add(waiter)
        })
    },
  }
}

/**
 * The "wake up" gate.
 *
 * A frame from the server wakes the loop, but a frame that arrived a moment BEFORE the
 * wait must not be lost. Otherwise you get a deadlock: the server answered `state`
 * right after our `state`, the loop at that moment had not yet subscribed to the
 * wake-up, the frame went nowhere — and the server believes it will wake the client
 * with the next frame, which may not exist at all (the work is already in the queue).
 *
 * That is why `nudge()` remembers the event: the next `wait()` returns at once.
 */
export function createWakeGate () {
  let pending = false
  let waiter = null
  return {
    /** An event has arrived. */
    nudge () {
      pending = true
      const resolve = waiter
      waiter = null
      resolve?.()
    },
    /** The event has already happened and is not used yet — there is nothing to wait for. */
    take () {
      if (!pending) return false
      pending = false
      return true
    },
    /** Wait for an event (without a timer). */
    wait () {
      return new Promise((resolve) => { waiter = resolve })
    },
  }
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    reject(new Error('aborted'))
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
})

/**
 * Connect using a link with a code: there is nothing to confirm, the code ties
 * everything together by itself.
 * @returns {Promise<object>} server record with the token
 */
/**
 * Save the server runtime: the epoch and the rest — in state.sqlite, the token — in
 * credentials.yaml. Nothing is written into config.json: only settings live there.
 */
function persist (store, url, state) {
  store.writeState(url, {
    epoch: state.epoch ?? null,
    boot: state.boot ?? null,
    node: state.node ?? null,
    alias: state.alias ?? null,
    apiIds: state.apiIds ?? {},
  })
  if ('token' in state) store.setToken(url, state.token ?? null)
}

/**
 * Sandbox for a single command.
 *
 * The mode comes from the server (`sandbox.mode`), but the node owner limits it from
 * above through `config.max`: the effective mode is the narrower of the two. The
 * session directory becomes the working directory of the command, and in `rw` mode the
 * only place that may be written to at all (plus `/tmp`).
 *
 * @param {object} config node settings
 * @param {object} command command from the queue
 * @param {object} sessions store of session directories
 * @returns {object|null} sandbox description, or null if the command is outside the sandbox
 */
/** Node rules for a particular server: policy[url] on top of the common settings. */
export function policyFor (config, url) {
  const common = {
    max: config.access?.max ?? 'rw',
    roots: config.roots ?? null,
    workdir: config.workdir ?? null,
    maxConcurrent: config.maxConcurrent ?? 5,
    // the mode the command starts in: `full` = do not lower (as it used to be)
    base: config.access?.base ?? 'full',
    approver: config.access?.approver ?? 'none',
    approvalTtlSeconds: config.approvalTtlSeconds ?? 86400,
    // the application-level ping: the arithmetic lives in ping-policy.mjs, but the number
    // itself has to reach `openPresence`. A policy that drops it silently gives a client
    // that never pings while `dshnc status` honestly prints "пинг 15 с"
    pingInterval: config.pingInterval ?? 0,
    maxPingIntervalFactor: config.maxPingIntervalFactor ?? 0,
    // `ask` — the channels (web/local). That is not the same as "is asking allowed":
    // the boolean for the server is computed from approver, see askEnabled below.
    ask: config.ask ?? null,
  }
  const own = url ? config.policy?.[url] ?? {} : {}
  return { ...common, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined && value !== null)) }
}

/**
 * Whether the server is allowed to ask the human on this node.
 *
 * What goes into the protocol is exactly a boolean (`allowEscalation`), while
 * `approver` describes the channel: `local` — we ask on the machine, `server` —
 * through DSH, `none` — never.
 *
 * @param {object} policy node rules
 * @returns {boolean}
 */
export function askEnabled (policy) {
  return policy?.approver === 'local' || policy?.approver === 'server'
}

/**
 * The local approval command from the node settings.
 *
 * `ask.local.enabled: false` or an empty template mean "there is nobody to ask" — then
 * the plugin returns `no_local_approver`, and the server will not pretend that the
 * question was put.
 *
 * @param {object} config client settings
 * @returns {string|null}
 */
export function askLocalCommand (policy) {
  const local = policy?.ask?.local
  if (!local?.enabled) return null
  const command = local.tool?.command
  return typeof command === 'string' && command.trim() ? command.trim() : null
}

export function sandboxFor (config, command, sessions, url) {
  const policy = policyFor(config, url)
  const requested = MODES.includes(command.sandbox?.mode) ? command.sandbox.mode : policy.max
  // the node cap always trims what was requested
  const want = narrower(requested, policy.max)
  // `base` is "which mode we start in", but a command confirmed by the human must not be
  // lowered: otherwise the approval means nothing
  const approved = Boolean(command.approved)
  const mode = approved || policy.approver === 'none' ? want : narrower(want, policy.base)
  let cwd = null
  if (command.session && sessions) {
    try {
      cwd = sessions.cwd(command.session, { workdir: policy.workdir, roots: policy.roots })
    } catch {
      cwd = policy.workdir ?? null
    }
  } else {
    cwd = policy.workdir ?? null
  }
  const workdir = policy.workdir ? canonicalWorkdir(policy.workdir) : null
  const roots = policy.roots?.length ? policy.roots : (workdir ? [workdir] : ['/'])
  return {
    mode,
    dshMode: DSH_MODES[mode],
    order: config.access?.order ?? [],
    args: profileArgs({ mode, workdir, writable: roots, cwd }),
    cwd,
    probe,
    classify,
  }
}

function canonicalWorkdir (workdir) {
  try {
    return realpathSync(workdir)
  } catch {
    return workdir
  }
}

export async function pairServer ({ url, config, print }) {
  const { base, code } = api.parseConnectUrl(url)
  if (!code) throw new Error(t('connect.noCode'))
  const store = openStore()
  const state = { ...store.readState(base), token: store.token(base) }
  const response = await api.pair(base, { code, uuid: config.id, name: config.name, aliases: config.aliases })
  state.token = response.body.token
  state.epoch = null
  state.alias = response.body.alias ?? null
  state.node = response.body.node ?? null
  delete state.announced
  persist(store, base, state)
  print(t('connect.paired', { node: response.body.node, alias: response.body.alias }))
  return state
}

/**
 * Initial registration: the enrollment request and waiting for a human to approve it.
 * @param {object} options
 * @param {string} options.url
 * @param {object} options.config
 * @param {(line: string) => void} options.print
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} server record with the token
 */
export async function enrollServer ({ url, config, print, signal, forever = false }) {
  const base = normalizeUrl(url)
  const store = openStore()
  const state = { ...store.readState(base), token: store.token(base) }
  const uuid = config.id
  let announced = false
  let attempts = 0
  let repost = 0
  let retryMs = 5000
  for (;;) {
    if (signal?.aborted) throw new Error('aborted')
    // we repeat the enrollment request if it is old: it has its own TTL in the admin UI
    if (!announced || repost >= 30) {
      try {
        await api.enroll(base, { uuid, name: config.name, aliases: config.aliases, nonce: store.clientNonce() })
        if (!announced) {
          print(t('connect.requested', { name: config.name, short: uuid.slice(0, 8) }))
          print(t('connect.waiting', { base }))
        }
        announced = true
        repost = 0
      } catch (error) {
        if (error.code === 'unauthorized') throw error
        announced = false
      }
    }
    repost += 1
    try {
      const response = await api.enrollStatus(base, uuid, store.clientNonce())
      if (response.status === 200 && response.body?.token) {
        state.token = response.body.token
        state.epoch = null
        state.alias = response.body.alias ?? null
        state.node = response.body.node ?? null
        delete state.announced
        persist(store, base, state)
        print(t('connect.approved', { node: response.body.node ?? '?', alias: response.body.alias ?? '—' }))
        return state
      }
      if (response.body?.status === 'rejected') throw new Error(t('connect.rejected'))
      if (response.body?.status === 'handed') throw new Error(t('connect.handed'))
    } catch (error) {
      if (error.code === 'unauthorized') throw error
      if (/отклон|rejected/.test(error.message)) throw error
      // 409 "already issued" — the server does not know that we need a new token: we wait
      // for approval in the admin UI and remind about ourselves less and less often, not
      // every 5 seconds
      print(t('run.retry', { base, message: error.message, seconds: Math.round(retryMs / 1000) }))
      await sleep(retryMs, signal)
      retryMs = Math.min(Math.round(retryMs * 2), 60000)
      continue
    }
    attempts += 1
    if (!forever && attempts > 360) throw new Error(t('connect.timeout'))
    await sleep(2000, signal)
  }
}

/**
 * The loop of a single server. Returns only on cancellation or a fatal error.
 */
export async function runServer ({ url, config, print, signal, shell, plugins = null }) {
  const base = normalizeUrl(url)
  const store = openStore()
  // The generation lives in the state file: `null` until the server names one, and back to
  // `null` whenever the server says our idea of it is out of date.
  const state = { ...store.readState(base), token: store.token(base) }
  // The highest command number this process has executed. Never adopted from the server:
  // the old cursor was exactly that adoption, and it is gone.
  let maxCommandno = 0
  // The connection counter (`client_epoch` on the wire) grows with every announce and
  // lives on disk, so the server can keep one connection out of two.
  let clientEpoch = null
  const sessions = createSessionStore(store)
  const loaded = plugins ?? await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => print(message) })
  let reloadRequested = false
  // SIGHUP reads the config again and wakes the loop: without the wake-up the reload
  // would stay "accepted" but not applied — the loop sleeps until a frame from the server
  const onHup = () => {
    reloadRequested = true
    nudge()
  }
  process.on('SIGHUP', onHup)
  let backoff = 1000
  // SIGHUP changes config in place and leaves a mark: by it we understand that it is time
  // to re-announce the API and recreate the socket with the new rules
  let reloadToken = config.reloadToken ?? null
  // `announced` lives in the process memory, not in the config: after a client restart we
  // have to announce again — the server may have restarted, the contract may have changed.
  let announced = false
  let presence = null
  const gate = createWakeGate()
  /** Wake the loop: a `state` frame arrived, there is no need to wait for polling. */
  const nudge = () => gate.nudge()
  /** Which presence object is current: an event from an old socket must be ignored. */
  let presenceSerial = 0
  /**
   * Start over from the announce.
   *
   * This is the whole recovery story: the epoch goes back to `null`, the socket is
   * dropped and the announce is repeated — the answer names the current generation and
   * whatever was issued to the previous one is closed by the server. There is no cursor
   * to repair.
   */
  const resetGeneration = (code) => {
    print(t('run.generationReset', { base, code: code ?? '—' }))
    state.epoch = null
    persist(store, base, state)
    // the announce will bump the connection counter as well
    announced = false
    presence?.close()
    presence = null
    // dialogues of the previous life: the server does not remember them any more,
    // there is nobody to answer
    abortAllApprovals()
    // the loop may be asleep waiting for a frame: a new generation will not arrive by
    // itself, the announce has to be repeated now
    nudge()
  }
  /**
   * Wait for a frame without a timer.
   *
   * The only way to wake up is a notification from the socket or a daemon stop. If the
   * socket dies silently, the client will keep sleeping: that is the price of the event
   * scheme, and it is acceptable while the safety-net polling is off.
   */
  const waitForWake = () => new Promise((resolve) => {
    // the frame may have arrived between sending the wait frame and this wait
    if (gate.take()) return resolve()
    signal?.addEventListener?.('abort', () => resolve(), { once: true })
    gate.wait().then(() => { gate.take(); resolve() })
  })

  /**
   * Pause before a retry: it is interrupted only by a daemon stop.
   *
   * SIGHUP during such a pause waits for its end (up to 30 s): the config cannot be read
   * again earlier, the loop is not at that point right now. This is deliberate.
   *
   * There used to be a pause here that a socket frame could wake — and "retry in 30 s"
   * actually retried a second later: closing the socket woke the loop, it got 404 again
   * and fell asleep again. In the journal it looked like a tight loop with a promise of
   * thirty seconds.
   */
  const sleepQuietly = (ms) => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener?.('abort', done, { once: true })
  })

    /**
     * Context for the plugin: the session directory, the roots from the server rules and
     * the sandbox. Computed for every command — the policy and the directory may differ.
     */
    const pluginContext = (command) => {
      const policy = policyFor(config, base)
      return {
        shell,
        // the approval dialogue has its own signal: it is cancelled separately from the whole loop
        signal: command.signal ?? signal,
        workdir: policy.workdir ?? config.workdir,
        roots: policy.roots?.length ? policy.roots : (policy.workdir ? [policy.workdir] : ['/']),
        // `files` must not receive "/" as permission for everything: an empty list means
        // "directories are not configured", and that is a refusal, not freedom
        fileRoots: policy.roots?.length ? policy.roots : (policy.workdir ? [policy.workdir] : []),
        session: command.session ?? null,
        sessions,
        // file transfer goes over HTTP to the same server whose socket we hold
        server: base,
        token: state.token,
        approver: {
          command: askLocalCommand(policyFor(config, base)),
          run: (options) => askLocally({ ...options, timeout: options.timeout ?? config.approvalTtlSeconds ?? 86400 }),
        },
        sandbox: sandboxFor(config, command, sessions, base),
        // the `#INTERNAL.FLUSH` barrier waits with this: the pool is empty — so everything
        // that was before it has really finished
        // the barrier takes a slot itself, so we wait for "everybody except itself":
        drain: () => pool.whenIdle(1),
      }
    }

    /**
     * Executor pool: the cap on simultaneous commands from the node settings. `approve`
     * does not enter the pool — a dialogue with the human may hang for a day.
     */
    const pool = createPool({
      slots: policyFor(config, base).maxConcurrent ?? 5,
      run: (command) => executeOne(command),
    })

    /**
     * Execute one command and report. Extracted so that a batch can run in parallel while
     * the report for each command stays the same.
     */
    const executeOne = async (command) => {
      const ctx = pluginContext(command)
      const plugin = resolvePlugin(loaded, command, state.apiIds ?? {})
      // the control command and the approval dialogue do not take a slot: the barrier must
      // not wait for itself, and the approval even less so
      const isControl = String(command.method).startsWith('#')
      try {
        const outcome = plugin
          ? (typeof plugin.handleControl === 'function' && isControl
            ? await plugin.handleControl(command, ctx)
            : await plugin.handle(command, ctx))
          : { ok: false, code: 'unknown_method', message: t('run.noPlugin', { method: command.method }) }
        try {
          // `now` — our own clock in the envelope: the timing rule uses it to compute the
          // skew. This is not knowledge about the rules but a simple fact about the answer
          const delivered = await api.result(base, state.token, command.seq, { ...outcome, now: preciseNow() })
          // the server closed the command before us (timeout, abort): there is nobody to
          // hand the result to. This is not an error, but silence is wrong too — otherwise
          // it is unclear where the answer went
          if (delivered?.body?.late) {
            print(t('run.orphanResult', { seq: command.seq, method: command.method }))
          }
        } catch (error) {
          print(t('run.resultFailed', { seq: command.seq, message: error.message }))
        }
        // full mode limits nothing, so we leave a trace
        if (plugin && ctx.sandbox?.mode === 'full') {
          try {
            store.writeAudit({
              session: command.session ?? null,
              mode: 'full',
              command: typeof command.args?.command === 'string' ? command.args.command : JSON.stringify(command.args ?? {}),
              code: codeOf(outcome),
              at: Date.now(),
            })
          } catch (error) {
            print(t('run.auditFailed', { message: error.message }))
          }
        }
        const flag = outcome.ok ? t('run.ok') : t('run.error', { code: outcome.code ?? '' })
        print(t('run.command', { base, seq: command.seq, method: command.method, flag }))
      } catch (error) {
        // a crash of the handler must not leave the command without an answer: otherwise
        // the server waits for its timeout and considers the result lost
        print(t('run.command', { base, seq: command.seq, method: command.method, flag: t('run.error', { code: 'client_error' }) }))
        await api.result(base, state.token, command.seq, {
          ok: false,
          code: 'client_error',
          message: error?.message ?? String(error),
        }).catch(() => {})
      }
    }

    /**
     * Start a batch without waiting for it as a whole.
     *
     * There are no special lanes any more: both the work and the control commands
     * (including the question to the human) go through the pool, and they differ only in
     * their priority within the server queue. `chdir` is not privileged either — order is
     * the job of the `flushAround` rule: the barrier issues it to one command, before and
     * after an empty pool.
     *
     * We do not wait for the commands: the loop must get back to fetching, otherwise,
     * while a long command runs, the client will not pick up `#INTERNAL.CANCEL`, and
     * there will be nothing to cancel it with.
     */
    const startBatch = (batch) => {
      for (const command of batch) void pool.submit(command)
    }

  while (!signal?.aborted) {
    try {
      if (reloadRequested) {
        reloadRequested = false
        print(t('daemon.reload'))
        const fresh = openStore().settings ?? {}
        for (const key of Object.keys(config)) delete config[key]
        Object.assign(config, fresh)
        // the new rules must reach the server: we re-announce and recreate the socket,
        // otherwise the changed base/approver/ping stay on paper
        announced = false
        presence?.close()
        presence = null
      }
      if ((config.reloadToken ?? null) !== reloadToken) {
        reloadToken = config.reloadToken ?? null
        // the policy, the rights and the question channels may have changed: we announce
        // again and recreate the socket — otherwise the new pingInterval/approver are not
        // picked up
        announced = false
        presence?.close()
        presence = null
      }
      // a daemon without a token goes into enrollment itself and waits for approval: then
      // the connection appears from the admin UI by itself, without restarting the client
      if (!state.token) {
        await enrollServer({ url: base, config, print, signal, forever: true })
        // the enrollment was approved in another call: we re-read the state, otherwise we
        // go on with the old empty token and get 401
        Object.assign(state, store.readState(base), { token: store.token(base) })
      }
      if (!announced) {
        // every announce is a new connection generation: the counter grows, otherwise the
        // server would take this instance for the one it has just dropped
        clientEpoch = store.nextClientEpoch(base)
        const response = await api.announce(base, state.token, apisOf(loaded), {
          applyRules: rulesOf(loaded),
          // our generation, or null when we know none: null is also how the client says
          // "I restarted", and closing what the previous life was issued is the server's job
          epoch: state.epoch,
          clientEpoch,
          workdir: config.workdir ?? null,
          access: policyFor(config, base).max,
          allowEscalation: askEnabled(policyFor(config, base)),
          uptimeSeconds: process.uptime(),
          approver: policyFor(config, base).approver,
          startMode: policyFor(config, base).base,
        })
        announced = true
        state.epoch = response.body.epoch ?? null
        state.apiIds = {}
        for (const entry of response.body.apis ?? []) state.apiIds[entry.name] = entry.id
        persist(store, base, state)
        const names = (response.body.apis ?? []).map((entry) => `${entry.name}#${entry.id}`).join(', ')
        print(t('run.announced', { base, apis: names, epoch: state.epoch }))
        for (const warning of response.body.warnings ?? []) print(t('run.warning', { warning }))
      }

      if (!presence) {
        const serial = ++presenceSerial
        presence = openPresence({
          base,
          token: state.token,
          // the numbers are read at the moment of sending: the epoch may be reset, the
          // announce may bump the counter and max_commandno grows while the socket lives
          getEpoch: () => state.epoch,
          getClientEpoch: () => clientEpoch,
          getMaxCommandno: () => maxCommandno,
          // read from the policy of this very server: without these two the presence has
          // `pingInterval = 0`, which means "pinging is off" — and the panel shows an online
          // node that never pings
          pingInterval: policyFor(config, base).pingInterval,
          maxPingIntervalFactor: policyFor(config, base).maxPingIntervalFactor,
          log: (level, message) => print(`${base}: ${message}`),
          onEvent: (event) => {
            // an event from a socket that has already been replaced is not ours to act on
            if (serial !== presenceSerial) return
            if (event.type === 'state') {
              // the frame carries the generation too: we adopt it when we know none, and a
              // different one means the server has started a new life
              if (event.epoch != null && state.epoch == null) {
                state.epoch = event.epoch
                persist(store, base, state)
              } else if (event.epoch != null && state.epoch !== event.epoch) {
                return resetGeneration('epoch-mismatch')
              }
              // "my number is higher than yours, go fetch": the number in the frame is the
              // same fact the fetch answer carries, so it is accepted here too — otherwise
              // the claim stays below the server's and the frame comes back on every `state`
              maxCommandno = adoptCommandno(maxCommandno, event.max_commandno)
              nudge()
            }
            if (event.type === 'closed') {
              presence = null
              // 4001 `replaced` — another instance of this node is newer: this one is
              // superfluous. Exiting (code 0, so a service manager does not restart it) is
              // the only safe answer: reconnecting would mean two clients pushing each other
              // out and raising `client_epoch` forever
              if (event.code === 4001 && event.reason === 'replaced') {
                print(t('run.presenceReplaced', { base, code: event.code }))
                signal?.abort?.()
                setTimeout(() => process.exit(0), 50)
                return
              }
              // 4409 — the generation changed, 4001 `client-epoch` — our connection counter
              // is stale: in both cases the whole connection is out of date, so we reset the
              // epoch and start over from the announce
              if (event.code === 4409 || event.code === 4001) return resetGeneration(String(event.code))
              print(t('run.presenceClosed', { base, code: event.code }))
              // pause before a new attempt: without it an unreachable server produces a tight
              // loop of connections
              setTimeout(nudge, 1000)
            }
          },
        })
      }

      // we take no more than fits into the free slots: what the server issued already
      // counts as issued, and the "extra" would hang somewhere unclear at our side
      const batchLimit = Math.max(1, Math.min(Number(config.batch) || 5, pool.free || 1))
      // our generation and our connection counter travel with the request: on a mismatch
      // the server answers 409 epoch-mismatch or 409 client-epoch-stale
      const response = await api.commands(base, state.token, {
        limit: batchLimit,
        epoch: state.epoch,
        clientEpoch,
        signal,
      })
      presence?.noteSeen?.()
      const commands = response.body.commands ?? []
      // the answer may name the generation too: we adopt it when we know none, and a
      // different one means the server has restarted
      if (response.body.epoch != null) {
        if (state.epoch == null) {
          state.epoch = response.body.epoch
          persist(store, base, state)
        } else if (state.epoch !== response.body.epoch) {
          resetGeneration('epoch-mismatch')
          continue
        }
      }
      // `max_commandno` — the number we claim. The batch raises it by what we really got,
      // and the answer's own number is accepted as well: numbers spent before this process
      // started are never handed out again, so counting the batch alone leaves the claim
      // below the server's forever and every `state` frame comes back with another one
      for (const command of commands) {
        if (Number.isFinite(command.seq) && command.seq > maxCommandno) maxCommandno = command.seq
      }
      maxCommandno = adoptCommandno(maxCommandno, response.body.max_commandno)
      presence?.sendState()

      if (!commands.length) {
        // There is no polling at all and no settings for it either: the only reason to
        // wake up is a frame from the server or a socket reconnect. That is by design: the
        // socket carries state, not events, and while the node sleeps the server may change
        // it as many times as it likes.
        // Subscribe BEFORE the wait frame, not after: the answer may arrive at the same
        // instant, and the listener must already be ready.
        const sleeping = waitForWake()
        presence?.sendState()
        await sleeping
        continue
      }
      backoff = 1000
      presence?.noteCommands?.()
      await startBatch(commands)
      presence?.sendState()
      // slots are exhausted — we wait until at least one is free, and go fetch further at
      // once: the server queue must not wait for the end of a long command
      if (pool.free === 0) await pool.whenFree()
    } catch (error) {
      presence?.close()
      presence = null
      if (signal?.aborted) return
      // the generation or the connection counter is out of date: reset the epoch, drop the
      // socket and start over from the announce
      if (api.isGenerationMismatch(error)) {
        resetGeneration(error.code)
        continue
      }
      // only our code: a 401 from a proxy (an HTML page) is no reason to wipe the token
      if (error.code === 'unauthorized') {
        print(t('run.tokenRejected', { base }))
        state.token = null
        announced = false
        persist(store, base, state)
        continue
      }
      print(t('run.retry', { base, message: error.message, seconds: Math.round(backoff / 1000) }))
      await sleepQuietly(backoff)
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}
