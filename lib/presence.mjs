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
export function openPresence ({ base, token, epoch = null, known = null, getKnown = null, onEvent, workdir = null, access = null, allowEscalation = true, uptimeSeconds = null, approver = null, aliveMs = 20_000, log = () => {} }) {
  const wsUrl = base.replace(/^http/, 'ws') + '/v1/ws'
  let serverEpoch = null
  let closed = false
  let socket
  let aliveTimer
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

  socket.addEventListener('open', () => {
    connected = true
    // workdir едет в hello: сервер покажет его в админке и будет знать,
    // где у узла корень рабочих каталогов сессий
    send({ t: 'hello', epoch, known, proto: PROTO, workdir: workdir ?? null, access: access ?? null, allowEscalation: allowEscalation ?? true, uptimeSeconds: uptimeSeconds ?? null, approver: approver ?? null })
    // номер берём в момент отправки: иначе клиент вечно рапортует то, что знал
    // при подключении, и сервер каждый раз считает его отставшим
    aliveTimer = setInterval(() => send({ t: 'alive', known: currentKnown() }), aliveMs)
    if (typeof aliveTimer.unref === 'function') aliveTimer.unref()
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
      onEvent?.({ type: 'hello-ok', ...frame })
      return
    }
    if (frame.t === 'state') {
      if (frame.epoch != null) serverEpoch = frame.epoch
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
    sendAlive: (value) => send({ t: 'alive', known: value ?? currentKnown() }),
    online: () => connected,
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
