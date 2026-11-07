/**
 * Присутствие клиента: WebSocket с `hello`, `alive` и кадром `state`.
 *
 * Токен едет подпротоколом — заголовком `Sec-WebSocket-Protocol`, а не в URL.
 * Клиент не обязан держать соединение: без него он работает опросом, просто
 * узнаёт о работе с задержкой до периода опроса.
 *
 * @module dsh-node-client/presence
 */
import { PROTO } from './api.mjs'
import { pingDelay } from './ping-policy.mjs'
import { t } from './i18n.mjs'

/**
 * Открыть присутствие.
 * @param {object} options
 * @param {string} options.base адрес сервера, например `https://dsh.example/dsh-nodes`
 * @param {string} options.token токен узла
 * @param {string|null} options.epoch поколение, которое клиент помнит
 * @param {number|null} options.known курсор узла
 * @param {(event: object) => void} options.onEvent `state` | `hello-ok` | `closed`
 * @param {number} [options.aliveMs] период `alive`
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {{sendAlive: (known: number|null) => void, close: () => void, epoch: () => number|null}}
 */
export function openPresence ({ base, token, epoch = null, known = null, getKnown = null, onEvent, workdir = null,
  access = null, allowEscalation = true, uptimeSeconds = null, approver = null, aliveMs = 20_000,
  pingInterval = 0, maxPingIntervalFactor = 0, log = () => {} }) {
  const wsUrl = base.replace(/^http/, 'ws') + '/v1/ws'
  let serverEpoch = null
  let closed = false
  let socket
  let aliveTimer
  // Расписание прикладного пинга: см. lib/ping-policy.mjs. Здесь только
  // исполнение — арифметика живёт в чистой функции и проверяется тестом.
  let pingTimer = null
  let pongWatchdog = null
  let lastSeenAt = Date.now()
  let ticksWithoutCommands = 0
  let pingSeq = 0
  let awaitingPong = null
  let connected = false
  /** Что клиент знает о последнем номере команды прямо сейчас. */
  const currentKnown = () => (typeof getKnown === 'function' ? getKnown() : known) ?? null

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
   * Поставить пинг на паузу по правилам (арифметика — в ping-policy.mjs).
   *
   * Пауза отсчитывается от последнего успешного общения: если сервер только что
   * ответил, пинг не нужен — таймер перезапустится.
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

  /** Любое успешное общение с сервером сдвигает отсчёт пинга. */
  function noteSeen () {
    lastSeenAt = Date.now()
    if (pongWatchdog) {
      clearTimeout(pongWatchdog)
      pongWatchdog = null
    }
    schedulePing()
  }

  /** Сервер прислал команды: растягивать паузу больше не за что. */
  function noteCommands () {
    ticksWithoutCommands = 0
    noteSeen()
  }

  socket.addEventListener('open', () => {
    connected = true
    // workdir едет в hello: сервер покажет его в админке и будет знать,
    // где у узла корень рабочих каталогов сессий
    send({ t: 'hello', epoch, known, proto: PROTO, workdir: workdir ?? null, access: access ?? null, allowEscalation: allowEscalation ?? true, uptimeSeconds: uptimeSeconds ?? null, approver: approver ?? null })
    // номер берём в момент отправки: иначе клиент вечно рапортует то, что знал
    // при подключении, и сервер каждый раз считает его отставшим
    aliveTimer = setInterval(() => send({ t: 'check_state', known: currentKnown() }), aliveMs)
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
      // сразу заявляем ожидание: иначе сервер, у которого уже есть работа, не
      // имеет права присылать кадр (он шлёт только ждущим)
      send({ t: 'check_state', known: currentKnown() })
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
    // close всё равно придёт; здесь только чтобы не падало
  })

  return {
    sendAlive: (value) => send({ t: 'check_state', known: value ?? currentKnown() }),
    online: () => connected,
    // демон сообщает presence о жизни: после каждого удачного HTTP-ответа и
    // после каждой пачки команд
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
