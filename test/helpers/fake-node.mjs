/**
 * Fake dsh-nodes server for the client behaviour tests.
 *
 * Brings up HTTP and WebSocket on one port and lets the test control what
 * happens: which commands are handed out, how results are answered, what the server
 * sends into the socket. That is how behaviour is checked, not strings in the source.
 *
 * @module dsh-node-client/test/helpers/fake-node
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/**
 * @param {object} [options]
 * @param {object[]} [options.commands] queue of commands to hand out (fetched one per request)
 * @param {number} [options.resultStatus] response code for result submission (409 means "too late")
 * @param {boolean} [options.pushOnCheckState] answer `state` right to `check_state`
 */
export async function startFakeNode ({ commands = [], resultStatus = 200, pushOnCheckState = false } = {}) {
  const calls = { commands: [], results: [], frames: [], announce: 0, state: 0, requests: [] }
  // "the server is broken": the plugin behind a proxy serves HTML instead of JSON
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
    // the "broken" server does not bring up the socket either: this is how a proxy behaves
    // when it serves HTML instead of an upgrade - the connection drops at once
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
    /** Start answering 404 and HTML, like a proxy without a running plugin. */
    breakHttp: (status = 404) => { broken = status },
    /** Drop all sockets: we check reconnection, not polling. */
    dropSockets: () => {
      for (const client of wss.clients) client.terminate()
    },
    commands,
    close: async () => {
      // drop the sockets first, then the server: `wss.close()` cannot be awaited -
      // it waits for clients to close, while the client is reconnecting at that very moment
      for (const client of wss.clients) client.terminate()
      wss.close()
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

/** Wait until the condition holds (no sleep hacks with a fixed delay). */
export async function waitFor (check, { timeoutMs = 3000, stepMs = 20 } = {}) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return false
}
