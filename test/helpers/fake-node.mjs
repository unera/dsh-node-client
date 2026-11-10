/**
 * Фейковый сервер dsh-nodes для поведенческих тестов клиента.
 *
 * Поднимает HTTP и WebSocket на одном порту и даёт тесту управлять тем, что
 * происходит: какие команды выдаются, как отвечают на результат, что сервер
 * шлёт в сокет. Так проверяется поведение, а не строки в исходнике.
 *
 * @module dsh-node-client/test/helpers/fake-node
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/**
 * @param {object} [options]
 * @param {object[]} [options.commands] очередь выдаваемых команд (забираются по одной за запрос)
 * @param {number} [options.resultStatus] код ответа на отправку результата (409 — «опоздал»)
 * @param {boolean} [options.pushOnCheckState] отвечать `state` сразу на `check_state`
 */
export async function startFakeNode ({ commands = [], resultStatus = 200, pushOnCheckState = false } = {}) {
  const calls = { commands: [], results: [], frames: [], announce: 0, state: 0, requests: [] }
  // «сервер сломался»: плагин за прокси отдаёт HTML, а не JSON
  let broken = null
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    calls.requests.push({ path: url.pathname, at: Date.now() })
    if (broken) {
      res.writeHead(broken, { 'content-type': 'text/html' })
      res.end(`<html><body>${broken === 401 ? 'auth required' : 'not found'}</body></html>`)
      return
    }
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.pathname.endsWith('/v1/announce')) {
        calls.announce += 1
        const parsed = body ? JSON.parse(body) : {}
        const apis = (parsed.apis ?? []).map((api, index) => ({ id: index + 1, name: api.name, version: api.version ?? null }))
        return send(200, { apis, warnings: [], epoch: 1, max_commandno: 0, node: 1 })
      }
      if (url.pathname.endsWith('/v1/state')) {
        calls.state += 1
        return send(200, { node: 1, online: true, epoch: 1, max_commandno: 0, queued: 0, ready: 0, waiting: 0 })
      }
      if (url.pathname.endsWith('/v1/commands')) {
        calls.commands.push(Date.now())
        const next = commands.shift()
        const payload = {
          commands: next ? [next] : [],
          ready: commands.length,
          epoch: 1,
          max_commandno: next ? next.seq : 0,
        }
        return send(200, payload)
      }
      const result = /\/v1\/commands\/(\d+)\/result$/.exec(url.pathname)
      if (result) {
        const parsed = body ? JSON.parse(body) : {}
        calls.results.push({ seq: Number(result[1]), body: parsed })
        return send(resultStatus, resultStatus === 200 ? { ok: true } : { code: 'bad_request', message: 'команда уже закрыта' })
      }
      return send(404, { code: 'bad_request', message: `нет маршрута ${url.pathname}` })
    })
  })

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    // «сломанный» сервер не поднимает и сокет: именно так ведёт себя прокси,
    // который отдаёт HTML вместо апгрейда — соединение рвётся сразу
    if (broken) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  })
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      calls.frames.push(frame)
      if (frame.t === 'hello') {
        ws.send(JSON.stringify({ t: 'hello-ok', epoch: 1, max_commandno: 0, reconnect: false }))
      }
      if (frame.t === 'check_state' && pushOnCheckState) {
        ws.send(JSON.stringify({ t: 'state', max_commandno: 1, epoch: 1 }))
      }
      if (frame.t === 'ping') ws.send(JSON.stringify({ t: 'pong', id: frame.id ?? null }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}/dsh-nodes`,
    calls,
    /** Начать отвечать 404 и HTML, как прокси без поднятого плагина. */
    breakHttp: (status = 404) => { broken = status },
    /** Разорвать все сокеты: проверяем переподключение, а не опрос. */
    dropSockets: () => {
      for (const client of wss.clients) client.terminate()
    },
    commands,
    close: async () => {
      // сначала рвём сокеты, потом сервер: ждать `wss.close()` нельзя —
      // он ждёт, пока закроются клиенты, а клиент в этот момент переподключается
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** Подождать, пока условие выполнится (без sleep-хаков на фиксированное время). */
export async function waitFor (check, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}
