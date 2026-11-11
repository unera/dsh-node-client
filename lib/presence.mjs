/**
 * Client presence: a WebSocket with exactly two frames, `state` and `ping`.
 *
 * `{t:'state', epoch, client_epoch, max_commandno}` is "I am waiting": my generation, my
 * connection counter and my own last command number. It replaces the old `hello`,
 * `check_state` and `known`; there is no handshake frame and no cursor any more.
 * `{t:'ping', no}` checks that the server is alive.
 *
 * `client_epoch` travels in the same frame as `epoch` on purpose: from it the server
 * closes a stale instance with `4001 client-epoch`, so a second client cannot take the
 * work of the first one silently.
 *
 * The token travels as a subprotocol — in the `Sec-WebSocket-Protocol` header, not
 * in the URL.
 *
 * @module dsh-node-client/presence
 */
import { pingDelay } from './ping-policy.mjs'
import { t } from './i18n.mjs'

/**
 * Open presence.
 * @param {object} options
 * @param {string} options.base server address, for example `https://dsh.example/dsh-nodes`
 * @param {string} options.token node token
 * @param {() => number|null} [options.getEpoch] the generation we know, or null
 * @param {() => number|null} [options.getClientEpoch] the connection counter
 * @param {() => number} [options.getMaxCommandno] the highest number we executed
 * @param {(event: object) => void} options.onEvent `state` | `closed`
 * @param {number} [options.aliveMs] period of the "I am waiting" frame; 0 or less — only
 *   after real work, which is the default
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {{sendState: () => void, close: () => void, epoch: () => number|null, online: () => boolean}}
 */
export function openPresence ({ base, token, getEpoch = () => null, getClientEpoch = () => null,
  getMaxCommandno = () => 0, onEvent, aliveMs = 0, pingInterval = 0, maxPingIntervalFactor = 0,
  openTimeoutMs = 0, log = () => {} }) {
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
  // the channel is over: either the socket said so, or we said it for the socket. Everything
  // that closes the connection goes through `finish` exactly once
  let finished = false
  let openWatchdog = null

  /**
   * Drop every timer and let the socket go. No answers expected: on a dead path the
   * library's own `close()` only sends a close frame and waits for an answer that never
   * comes.
   */
  const teardown = () => {
    closed = true
    connected = false
    clearInterval(aliveTimer)
    clearTimeout(pingTimer)
    clearTimeout(pongWatchdog)
    clearTimeout(openWatchdog)
    try {
      socket?.close()
    } catch {}
  }

  /**
   * End this channel and tell the daemon — the one door, whoever noticed first.
   *
   * The daemon reconnects on the `closed` event and on nothing else. Waiting for the
   * library to produce that event is what kept a node silently offline for hours once its
   * route disappeared: the socket stays ESTABLISHED, nothing arrives, and `close()` waits
   * for a peer that is not there. So a watchdog finishes the channel itself and synthesizes
   * the event; the abandoned socket is closed best-effort and forgotten.
   */
  const finish = (code, reason) => {
    if (finished) return
    finished = true
    teardown()
    onEvent?.({ type: 'closed', code, reason })
  }

  const send = (payload) => {
    if (closed || socket?.readyState !== 1) return
    try {
      socket.send(JSON.stringify(payload))
    } catch (error) {
      log('warn', t('presence.sendFailed', { message: error.message }))
    }
  }

  /**
   * "I am waiting" — the only thing the server needs to know to wake us up. The numbers
   * are taken at the moment of sending: a snapshot at connect time would make the node
   * look lagging forever.
   */
  const sendState = () => {
    send({
      t: 'state',
      epoch: getEpoch() ?? null,
      client_epoch: getClientEpoch() ?? null,
      max_commandno: Number(getMaxCommandno()) || 0,
    })
  }

  try {
    socket = new WebSocket(wsUrl, [token])
    // a handshake can hang as easily as a live channel: an unreachable route leaves the
    // socket connecting and the `close` event just as absent
    const openLimit = openTimeoutMs > 0 ? openTimeoutMs : Math.max(15_000, Number(pingInterval) * 2_000)
    openWatchdog = setTimeout(() => {
      log('warn', t('presence.openTimeout', { seconds: Math.round(openLimit / 1000) }))
      finish(4003, 'нет открытия')
    }, openLimit)
    if (typeof openWatchdog.unref === 'function') openWatchdog.unref()
  } catch (error) {
    log('warn', t('presence.openFailed', { message: error.message }))
    return { sendState: () => {}, close: () => {}, epoch: () => null, online: () => false }
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
      const no = ++pingSeq
      awaitingPong = no
      send({ t: 'ping', no })
      pongWatchdog = setTimeout(() => {
        log('warn', t('presence.pongTimeout', { seconds: Math.round(delay / 1000) }))
        // not "ask the socket to close": on a black-hole TCP that request is never answered
        // and no close event follows, so the channel is finished here and now
        log('warn', t('presence.forceClose', { code: 4002, reason: 'нет понга' }))
        finish(4002, 'нет понга')
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
    clearTimeout(openWatchdog)
    connected = true
    // the very first frame is "I am waiting": there is no hello, and the server has no
    // reason to send anything to a node that has not declared its state
    sendState()
    // The periodic "I am waiting" is off by default. The server arms `waiting` on every
    // frame we send and drops it only when it pushes work, and we send `state` right after
    // every fetch and every batch — the timer therefore repeats a fact the server already
    // knows, costs a `last_seen` write per tick and keeps the panel's counter growing.
    // `aliveMs > 0` keeps the old behaviour for anyone who wants a keepalive.
    if (aliveMs > 0) {
      aliveTimer = setInterval(sendState, aliveMs)
      if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
    }
    schedulePing()
  })

  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return log('warn', t('presence.badFrame'))
    }
    if (frame.t === 'pong') {
      if (awaitingPong !== null && frame.no === awaitingPong) awaitingPong = null
      ticksWithoutCommands += 1
      noteSeen()
      return
    }
    if (frame.t === 'state') {
      if (frame.epoch != null) serverEpoch = frame.epoch
      noteSeen()
      onEvent?.({ type: 'state', epoch: frame.epoch ?? null, max_commandno: frame.max_commandno ?? null })
    }
  })

  socket.addEventListener('close', (event) => {
    finish(event.code, event.reason)
  })

  socket.addEventListener('error', () => {
    // close will arrive anyway; this handler is only here so that nothing crashes
  })

  return {
    sendState,
    online: () => connected,
    // the daemon tells presence about its liveness: after every successful HTTP
    // response and after every batch of commands
    noteSeen,
    noteCommands,
    close: () => {
      if (finished) return
      finished = true
      teardown()
    },
    epoch: () => serverEpoch,
  }
}
