/**
 * Pairing by a link with a code: the admin presses "connect client", the client
 * runs `dshnc connect <link>` and gets the token right away.
 *
 * We check with a real plugin server: the code is issued, burned, does not work a second
 * time, and after that the client announces its API and executes a command.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { WebSocketServer } from 'ws'

import { Store } from '../../dsh-nodes/lib/db.mjs'
import { Queue } from '../../dsh-nodes/lib/queue.mjs'
import { createNodesServer } from '../../dsh-nodes/lib/server.mjs'
import { handleAdmin } from '../../dsh-nodes/lib/admin-api.mjs'
import { createPresence } from '../../dsh-nodes/lib/ws.mjs'
import { loadConfig } from '../lib/config.mjs'
import { openStore } from '../lib/store.mjs'
import { pairServer, runServer } from '../lib/runner.mjs'
import { setLang } from '../lib/i18n.mjs'
import { loadPlugins } from '../lib/plugins/index.mjs'

// End-to-end tests bring up the daemon, connect over websocket and execute commands
// inside the sandbox: the GitHub runner has no bwrap, so here they are skipped, while
// locally and on a live host they run in full.
const skipInCi = process.env.CI ? { skip: 'нужен bwrap и живой демон' } : {}


const NODES_CONFIG = { routePrefix: '/dsh-nodes', aliveTimeoutSeconds: 60, maxPendingEnroll: 50, maxBodyBytes: 65536 }
const ADMIN = 'admin-pair'
let dir
let store
let queue
let presence
let server
let base
let config
let controller

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dshnc-pair-'))
  process.env.DSHNC_HOME = dir
  store = new Store(join(dir, 'nodes.sqlite'))
  queue = new Queue({ epoch: store.bumpEpoch(), defaultTimeout: 5 })
  presence = createPresence({ WebSocketServer, prefix: '/dsh-nodes', store, queue })
  const handler = createNodesServer({
    store,
    queue,
    config: { routePrefix: '/dsh-nodes', maxBodyBytes: 65536, aliveTimeoutSeconds: 60, maxPendingEnroll: 50 },
    adminToken: ADMIN,
    presence,
  })
  server = createServer((req, res) => handler.handle(req, res))
  server.on('upgrade', (req, socket, head) => presence.upgrade(req, socket, head))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/dsh-nodes`
  config = loadConfig()
  controller = new AbortController()
  setLang('en')
})

after(() => {
  controller?.abort()
  presence?.close()
  server?.close()
  store?.close()
  rmSync(dir, { recursive: true, force: true })
  delete process.env.DSHNC_HOME
})

// The admin UI no longer lives on a public prefix: operations are invoked
// by plugin functions with the same store and queue as the server that is up.
const deps = () => ({ store, queue, config: NODES_CONFIG, prefix: '/dsh-nodes', origin: base.replace(/\/dsh-nodes$/, '') })

/** A fresh snapshot of the server state: the daemon writes to sqlite, we read it again. */
function live (url) {
  const store = openStore()
  const state = store.readState(url)
  return { ...state, token: store.token(url) }
}

async function admin (path, options = {}) {
  const method = options.method ?? 'GET'
  const body = options.body ? JSON.parse(options.body) : {}
  const rest = String(path).replace(/^\/v1\/admin/, '')
  const parts = rest.split('/').filter(Boolean)
  if (parts[0] === 'pairing') return handleAdmin(deps(), 'POST', '/pairing', body)
  if (parts[0] === 'pending' && parts[2] === 'approve') return handleAdmin(deps(), 'POST', rest, body)
  if (parts[0] === 'pending' && parts[2] === 'reject') return handleAdmin(deps(), 'POST', rest, body)
  if (parts[0] === 'pending') return handleAdmin(deps(), 'GET', '/pending', {})
  if (parts[0] === 'nodes' && parts[1]) return handleAdmin(deps(), 'POST', rest, body)
  if (parts[0] === 'nodes') return handleAdmin(deps(), method, '/nodes', body)
  throw new Error(`нет админ-маршрута ${path}`)
}

/** Connect the client by a link: without this the further checks make no sense. */
async function ensurePaired () {
  if (live(base).token) return
  const link = await admin('/v1/admin/pairing', { method: 'POST', body: JSON.stringify({ ttlSeconds: 600 }) })
  assert.equal(link.status, 201)
  await pairServer({ url: link.body.url, config, print: () => {} })
  assert.ok(live(base).token, 'токен должен появиться после подключения')
}

test('a link from the admin UI connects the client without confirmation', skipInCi, async () => {
  const link = await admin('/v1/admin/pairing', { method: 'POST', body: JSON.stringify({ ttlSeconds: 600 }) })
  assert.equal(link.status, 201)
  assert.match(link.body.url, /\?v=/)

  const printed = []
  await pairServer({ url: link.body.url, config, print: (line) => printed.push(line) })
  let state = live(base)
  assert.ok(state.token, 'токен должен сохраниться')
  assert.ok(state.node, 'номер узла должен сохраниться')
  assert.match(printed.join(' '), /connected: node 1/)

  const again = await fetch(`${base}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: new URL(link.body.url).searchParams.get('v') }),
  })
  assert.equal(again.status, 409, 'код одноразовый')
})

test('after connecting the client announces plugins and executes a command', skipInCi, async () => {
  // the test must not depend on its neighbour: connect by itself if there is no token
  await ensurePaired()
  let state = live(base)
  const plugins = await loadPlugins({ dir: join(dir, 'plugins') })
  assert.deepEqual(plugins.map((plugin) => plugin.api.name), ['shell', 'job', 'files', 'session'])

  const running = runServer({ url: base, config, print: () => {}, signal: controller.signal, pollIdleMs: 200, plugins })

  for (let i = 0; i < 200 && !state.apiIds?.shell; i++) { await new Promise((resolve) => setTimeout(resolve, 100)); state = live(base) }
  assert.ok(state.apiIds?.shell, 'клиент должен объявить API')
  assert.ok(state.apiIds?.job, 'фоновые процессы объявляются отдельным API')

  const node = store.node(state.node)
  const apiId = state.apiIds.shell
  const { promise } = queue.enqueue({ nodeId: node.id, api: apiId, method: 'exec', args: { command: 'echo pairing-ok' }, timeout: 5 })
  const outcome = await promise
  assert.equal(outcome.status, 'ok')
  assert.match(outcome.results[0].text, /pairing-ok/)
})
