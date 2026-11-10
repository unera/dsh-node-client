/**
 * Client presence: a WebSocket with `hello`, `alive` and the `state` frame.
 *
 * The token travels as a subprotocol — in the `Sec-WebSocket-Protocol` header, not
 * in the URL. The client is not obliged to keep the connection: without it, it works
 * by polling, it just learns about work with a delay of up to the polling period.
 *
 * @module dsh-node-client/presence
 */
import { PROTO } from './api.mjs'
import { pingDelay } from './ping-policy.mjs'
import { t } from './i18n.mjs'

/**
 * Open presence.
 * @param {object} options
 * @param {string} options.base server address, for example `https://dsh.example/dsh-nodes`
 * @param {string} options.token node token
 * @param {string|null} options.epoch the generation the client remembers
 * @param {number|null} options.known the node cursor
 * @param {(event: object) => void} options.onEvent `state` | `hello-ok` | `closed`
 * @param {number} [options.aliveMs] period of `alive`
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {{sendAlive: (known: number|null) => void, close: () => void, epoch: () => number|null}}
 */
export function openPresence ({ base, token, epoch = null, known = null, getKnown = null, onEvent, workdir = null,
  access = null, allowEscalation = true, uptimeSeconds = null, approver = null, aliveMs = 20_000,
  pingInterval = 0, maxPingIntervalFactor = 0, startMode = null, conn = null,
  declareRestart = false, log = () => {} }) {
  const wsUrl = base.replace(/^http/, 'ws') + '/v1/ws'
  let serverEpoch = null
  let closed = false
  let socket
  let aliveTimer
  // Schedule of the application-level ping: see lib/ping-policy.mjs. Only execution
  // is here — the arithmetic lives in a pure function and is covered by a test.
  let pingTimer = null
  let pongWatchdog = null
  let lastSeenAt = Date.now()
  let ticksWithoutCommands = 0
  let pingSeq = 0
  let awaitingPong = null
  let connected = false
  /**
   * `known: null` means "everything you issued to me died with this process": the
   * server closes those commands as `node_restarted` (ws.mjs reacts to `check_state`,
   * not to `hello`). Said once — in the hello and in the very first `check_state`;
   * repeated in every frame it would close commands that are alive and well.
   */
  let restartPending = declareRestart === true
  /** What the client knows about the last command number right now. */
  const currentKnown = () => {
    if (restartPending) return null
    return (typeof getKnown === 'function' ? getKnown() : known) ?? 0
  }
  /** Every `check_state` goes through here: the first one carries the restart, then numbers. */
  const sendCheckState = () => {
    send({ t: 'check_state', known: currentKnown() })
    restartPending = false
  }

  const send = (payload) => {
    if (closed || socket?.readyState !== 1) return
    try {
      socket.send(JSON.stringify(payload))
    } catch (error) {
      log('warn', t('presence.sendFailed', { message: error.message }))
    }
  }

  try {
    socket = new WebSocket(wsUrl, [token])
  } catch (error) {
    log('warn', t('presence.openFailed', { message: error.message }))
    return { sendAlive: () => {}, close: () => {}, epoch: () => null }
  }

  /**
   * Schedule the ping pause according to the rules (the arithmetic is in
   * ping-policy.mjs).
   *
   * The pause is counted from the last successful exchange: if the server has just
   * answered, no ping is needed — the timer will restart.
   */
  function schedulePing () {
    if (pingTimer) clearTimeout(pingTimer)
    const delay = pingDelay({ pingInterval, factor: maxPingIntervalFactor, ticks: ticksWithoutCommands })
    if (!delay) return
    const elapsed = Date.now() - lastSeenAt
    pingTimer = setTimeout(() => {
      if (Date.now() - lastSeenAt < delay) return schedulePing()
      const id = ++pingSeq
      awaitingPong = id
      send({ t: 'ping', id })
      pongWatchdog = setTimeout(() => {
        log('warn', t('presence.pongTimeout', { seconds: Math.round(delay / 1000) }))
        try {
          socket.close(4002, 'нет понга')
        } catch {}
      }, delay)
      if (typeof pongWatchdog.unref === 'function') pongWatchdog.unref()
    }, Math.max(0, delay - elapsed))
    if (typeof pingTimer.unref === 'function') pingTimer.unref()
  }

  /** Any successful exchange with the server shifts the ping countdown. */
  function noteSeen () {
    lastSeenAt = Date.now()
    if (pongWatchdog) {
      clearTimeout(pongWatchdog)
      pongWatchdog = null
    }
    schedulePing()
  }

  /** The server sent commands: there is nothing left to stretch the pause for. */
  function noteCommands () {
    ticksWithoutCommands = 0
    noteSeen()
  }

  socket.addEventListener('open', () => {
    connected = true
    // workdir travels in hello: the server shows it in the admin UI and will know
    // where the node has the root of the session working directories
    send({ t: 'hello', epoch, known, proto: PROTO, workdir: workdir ?? null, access: access ?? null, allowEscalation: allowEscalation ?? true, uptimeSeconds: uptimeSeconds ?? null, approver: approver ?? null, base: startMode ?? null, conn: conn ?? null })
    // the number is taken at the moment of sending: otherwise the client would
    // forever report what it knew at connect time, and the server would consider it
    // lagging every time
    aliveTimer = setInterval(sendCheckState, aliveMs)
    if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
    schedulePing()
  })

  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return log('warn', t('presence.badFrame'))
    }
    if (frame.t === 'hello-ok') {
      serverEpoch = frame.epoch ?? null
      // we declare our expectation at once: otherwise a server that already has work
      // has no right to send a frame (it sends only to those who are waiting)
      sendCheckState()
      onEvent?.({ type: 'hello-ok', ...frame })
      return
    }
    if (frame.t === 'pong') {
      if (awaitingPong !== null && frame.id === awaitingPong) awaitingPong = null
      ticksWithoutCommands += 1
      noteSeen()
      return
    }
    if (frame.t === 'state') {
      if (frame.epoch != null) serverEpoch = frame.epoch
      noteSeen()
      onEvent?.({ type: 'state', ...frame })
    }
  })

  socket.addEventListener('close', (event) => {
    closed = true
    clearInterval(aliveTimer)
    onEvent?.({ type: 'closed', code: event.code, reason: event.reason })
  })

  socket.addEventListener('error', () => {
    // close will arrive anyway; this handler is only here so that nothing crashes
  })

  return {
    sendAlive: (value) => {
      if (restartPending) return sendCheckState()
      send({ t: 'check_state', known: value ?? currentKnown() })
    },
    /** Whether the one-shot restart declaration has already gone out. */
    restartAnnounced: () => !restartPending,
    /** The server changed generation: declare the restart again, once. */
    declareRestart: () => {
      restartPending = true
      sendCheckState()
    },
    online: () => connected,
    // the daemon tells presence about its liveness: after every successful HTTP
    // response and after every batch of commands
    noteSeen,
    noteCommands,
    close: () => {
      closed = true
      clearInterval(aliveTimer)
      try {
        socket.close(1000, 'bye')
      } catch {}
    },
    epoch: () => serverEpoch,
  }
}
