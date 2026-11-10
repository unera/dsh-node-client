/**
 * Connection to a single server: enrollment, announcement, the command loop.
 *
 * State is kept per URL (the client plan): cursor, epoch, token. Reconnect uses an
 * exponential pause, but without losing the token already obtained.
 *
 * @module dsh-node-client/runner
 */
import * as api from './api.mjs'
import { runBash } from './bash.mjs'
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
/**
 * Accept the number the server named.
 *
 * `known` is not "the maximum of the received numbers" but "up to which number I am
 * aware". Numbers are an honest auto-increment and are never reused, so a number from
 * the server also closes the holes: a cancelled command consumed a number, but it will
 * never reach the client, and catching up with it through the maximum of the received
 * ones is impossible.
 *
 * @param {number|null|undefined} current what the client knew before
 * @param {unknown} value `max_commandno` from a response or a frame
 * @returns {number} the new knowledge (not less than the previous)
 */
export function adoptMaxCommandno (current, value) {
  const known = Number.isFinite(Number(current)) ? Number(current) : 0
  const named = Number(value)
  if (!Number.isFinite(named)) return known
  return Math.max(known, named)
}

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
 * right after our `check_state`, the loop at that moment had not yet subscribed to the
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
 * Save the server runtime: the cursor and the rest — in state.sqlite, the token — in
 * credentials.yaml. Nothing is written into config.json: only settings live there.
 */
function persist (store, url, state) {
  store.writeState(url, {
    cursor: state.cursor ?? null,
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
  state.cursor = 0
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
        state.cursor = 0
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
  // A fresh process does not remember what was issued in its previous life: the taken
  // commands died together with it. That is why we announce "I know up to" as empty —
  // with `known: null` the server closes its hanging commands as node_restarted and does
  // not hold the queue because of them (in a live check a hanging barrier blocked the
  // node for half an hour).
  const state = { ...store.readState(base), token: store.token(base), cursor: null }
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
  /**
   * Wait for a frame without a timer.
   *
   * The only way to wake up is a notification from the socket or a daemon stop. If the
   * socket dies silently, the client will keep sleeping: that is the price of the event
   * scheme, and it is acceptable while the safety-net polling is off.
   */
  const waitForWake = () => new Promise((resolve) => {
    // the frame may have arrived between sending check_state and this wait
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
        const response = await api.announce(base, state.token, apisOf(loaded), {
          applyRules: rulesOf(loaded),
          workdir: config.workdir ?? null,
          access: policyFor(config, base).max,
          allowEscalation: askEnabled(policyFor(config, base)),
          uptimeSeconds: process.uptime(),
          approver: policyFor(config, base).approver,
          startMode: policyFor(config, base).base,
          // application-level ping: 0 — disabled, factor — the stretch cap
          pingInterval: config.pingInterval ?? 0,
          maxPingIntervalFactor: config.maxPingIntervalFactor ?? 0,
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

      // "I restarted, everything issued to me died" is said EXACTLY ONCE — by the first
      // socket frame. After that our state is 0: otherwise every `check_state` with
      // `known: null` is understood by the server as a new restart, and it closes the just
      // issued commands as `node_restarted` (that is what happened in a live check: exec
      // died a hundred and fifty milliseconds after being issued).
      if (state.cursor === null) {
        state.cursor = 0
        persist(store, base, state)
      }
      if (!presence) presence = openPresence({
        // connection number: by it the server decides whom to keep if the client came up
        // twice by accident
        conn: store.nextConn(base),
        workdir: policyFor(config, base).workdir ?? config.workdir ?? null,
        access: policyFor(config, base).max,
        allowEscalation: askEnabled(policyFor(config, base)),
        // process start time: the server will compute the uptime by its own clock
        uptimeSeconds: process.uptime(),
        approver: policyFor(config, base).approver,
        // `base` is the start mode: the server shows it in the panel next to the cap. In
        // presence the parameter is called startMode so as not to clash with the name of
        // the url base
        startMode: policyFor(config, base).base,
        base,
        token: state.token,
        epoch: state.epoch,
        known: state.cursor ?? null,
        log: (level, message) => print(`${base}: ${message}`),
        onEvent: (event) => {
          if (event.type === 'hello-ok') {
            if (event.reconnect) {
              print(t('run.reconnect', { base, from: state.epoch, to: event.epoch }))
              state.epoch = event.epoch
              state.cursor = 0
              persist(store, base, state)
            } else {
              state.epoch = event.epoch ?? state.epoch
            }
            // we report the cursor at once: the server will remember that the node is
            // waiting for work, and the very first command will come as a frame, not after
            // a polling period
            presence?.sendAlive(state.cursor ?? null)
            nudge()
          }
          if (event.type === 'state') {
            // the frame carries a number: we adopt it as our own, otherwise a hole in the
            // numbering (a cancelled command) will not let us catch up with the server
            // we do not adopt the number from the frame: it means "the server has more",
            // not "the client took everything". We will accept it when the queue empties
            nudge()
          }
          if (event.type === 'closed') {
            // 4001 — the connection was displaced by a new one, 4409 — it is stale. In both
            // cases this instance is superfluous: we leave, so that there are not two
            // clients snatching commands from each other.
            if (event.code === 4001 || event.code === 4409) {
              print(t('run.presenceReplaced', { base, code: event.code }))
              signal?.abort?.()
              // zero code: this is not a failure but a normal "I am superfluous". A service
              // with Restart=on-failure does not restart such an exit.
              setTimeout(() => process.exit(0), 50)
            }
            print(t('run.presenceClosed', { base, code: event.code }))
            presence = null
            // pause before a new attempt: without it an unreachable server produces a tight
            // loop of connections
            setTimeout(nudge, 1000)
          }
        },
      })

      // generation check: a mismatch = reconnect, cursor to zero (§4.7)
      const current = await api.state(base, state.token, { signal })
      if (state.epoch != null && current.body.epoch !== state.epoch) {
        print(t('run.restarted', { base, from: state.epoch, to: current.body.epoch }))
        state.epoch = current.body.epoch
        state.cursor = null
        // dialogues of the previous life: the server does not remember them any more,
        // there is nobody to answer
        abortAllApprovals()
        persist(store, base, state)
      }

      // we take no more than fits into the free slots: what the server issued already
      // counts as issued, and the "extra" would hang somewhere unclear at our side
      const batchLimit = Math.max(1, Math.min(Number(config.batch) || 5, pool.free || 1))
      const response = await api.commands(base, state.token, { limit: batchLimit, signal })
      presence?.noteSeen?.()
      const commands = response.body.commands ?? []
      if (state.epoch !== response.body.epoch) {
        state.epoch = response.body.epoch
        state.cursor = null
      }
      // `known` — up to which number I am aware. The server gives `state` (the last issued
      // number), but it cannot be relied on: it grows between issuances. That is why we
      // remember the maximum of the commands received — that is exactly what is asked in
      // `check_state`.
      for (const command of commands) {
        if (Number.isFinite(command.seq) && (state.cursor == null || command.seq > state.cursor)) state.cursor = command.seq
      }
      persist(store, base, state)
      presence?.sendAlive(state.cursor ?? null)

      if (!commands.length) {
        // There is no polling at all and no settings for it either: the only reason to
        // wake up is a frame from the server or a socket reconnect. That is by design: the
        // socket carries state, not events, and while the node sleeps the server may change
        // it as many times as it likes.
        //
        // The queue is exhausted — only now can the server's number be accepted in full.
        // Accepting it earlier is impossible: commands with smaller numbers may still be in
        // the queue, and "I know up to N" would leave them undelivered to us (that is what
        // happened in a live check of 0.0.91).
        state.cursor = adoptMaxCommandno(state.cursor, response.body.max_commandno)
        persist(store, base, state)

        // Subscribe BEFORE the question, not after: the answer to `check_state` may arrive
        // at the same instant, and the listener must already be ready.
        const sleeping = waitForWake()
        presence?.sendAlive(state.cursor ?? null)
        await sleeping
        continue
      }
      backoff = 1000
      presence?.noteCommands?.()
      await startBatch(commands)
      presence?.sendAlive(state.cursor ?? null)
      // slots are exhausted — we wait until at least one is free, and go fetch further at
      // once: the server queue must not wait for the end of a long command
      if (pool.free === 0) await pool.whenFree()
    } catch (error) {
      presence?.close()
      presence = null
      if (signal?.aborted) return
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
