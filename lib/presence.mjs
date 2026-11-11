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
  log = () => {} }) {
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
    closed = true
    connected = false
    clearInterval(aliveTimer)
    clearTimeout(pingTimer)
    clearTimeout(pongWatchdog)
    onEvent?.({ type: 'closed', code: event.code, reason: event.reason })
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
      closed = true
      clearInterval(aliveTimer)
      clearTimeout(pingTimer)
      clearTimeout(pongWatchdog)
      try {
        socket.close(1000, 'bye')
      } catch {}
    },
    epoch: () => serverEpoch,
  }
}
