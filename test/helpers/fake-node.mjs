/**
 * Fake dsh-nodes server for the client behaviour tests.
 *
 * Brings up HTTP and WebSocket on one port and lets the test control what
 * happens: which commands are handed out, how results are answered, what the server
 * sends into the socket, and when it decides that the client generation is stale. That
 * is how behaviour is checked, not strings in the source.
 *
 * The fake speaks the epoch protocol: `POST`-free announce with `epoch`/`client_epoch`,
 * `GET /v1/commands?limit&epoch&client_epoch`, and the two socket frames `state`/`pong`.
 *
 * @module dsh-node-client/test/helpers/fake-node
 */
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/**
 * @param {object} [options]
 * @param {object[]} [options.commands] queue of commands to hand out (fetched one per request)
 * @param {number} [options.resultStatus] response code for result submission (409 means "too late")
 * @param {boolean} [options.pushOnState] answer `state` right to a `state` frame
 * @param {number} [options.epoch] server generation named in the announce answer and in frames
 * @param {boolean} [options.bumpOnAnnounce] name a new generation on every announce
 * @param {string[]} [options.commandErrors] codes answered to `/v1/commands`, one per request
 * @param {number[]} [options.closeOnConnect] close codes for incoming sockets, one per connection
 * @param {object|null} [options.pushState] `state` frame sent right after a socket connects
 */
export async function startFakeNode ({
  commands = [],
  resultStatus = 200,
  pushOnState = false,
  epoch = 1,
  bumpOnAnnounce = false,
  commandErrors = [],
  closeOnConnect = [],
  pushState = null,
} = {}) {
  const calls = {
    commands: [],
    commandQueries: [],
    results: [],
    frames: [],
    announces: [],
    announce: 0,
    sockets: 0,
    requests: [],
  }
  let currentEpoch = epoch
  // "the server is broken": the plugin behind a proxy serves HTML instead of JSON
  let broken = null
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    calls.requests.push({ path: url.pathname, query: url.search, at: Date.now() })
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
        calls.announces.push(parsed)
        if (bumpOnAnnounce) currentEpoch += 1
        const apis = (parsed.apis ?? []).map((api, index) => ({ id: index + 1, name: api.name, version: api.version ?? null }))
        // no `max_commandno` in the answer: the client must not take its own report from here
        return send(200, { apis, warnings: [], epoch: currentEpoch, node: 1 })
      }
      if (url.pathname.endsWith('/v1/commands')) {
        calls.commands.push(Date.now())
        calls.commandQueries.push({
          limit: url.searchParams.get('limit'),
          epoch: url.searchParams.get('epoch'),
          client_epoch: url.searchParams.get('client_epoch'),
        })
        const failure = commandErrors.shift()
        if (failure) return send(409, { code: failure, message: failure })
        const next = commands.shift()
        const payload = {
          commands: next ? [next] : [],
          ready: commands.length,
          epoch: currentEpoch,
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
    calls.sockets += 1
    const drop = closeOnConnect.shift()
    if (drop) {
      ws.close(drop, 'test close')
      return
    }
    if (pushState) ws.send(JSON.stringify({ t: 'state', epoch: currentEpoch, ...pushState }))
    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      calls.frames.push(frame)
      if (frame.t === 'state' && pushOnState) {
        ws.send(JSON.stringify({ t: 'state', epoch: currentEpoch, max_commandno: 1 }))
      }
      // the reply names the same `no`: the client mixes up nothing
      if (frame.t === 'ping') ws.send(JSON.stringify({ t: 'pong', no: frame.no ?? null }))
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
    /** Wake the node the way the server does: a `state` frame on the live socket. */
    wake: (maxCommandno = 0) => {
      for (const client of wss.clients) client.send(JSON.stringify({ t: 'state', epoch: currentEpoch, max_commandno: maxCommandno }))
    },
    /** Start a new server generation (the old one is "restarted"). */
    setEpoch: (value) => { currentEpoch = Number(value) },
    epoch: () => currentEpoch,
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
