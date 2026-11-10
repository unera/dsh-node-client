/**
 * End-to-end test of the client: the real `runServer` loop against a real server
 * plugin. We check what it was all written for: a command reaches the machine,
 * bash is executed, the result comes back to the one waiting for it.
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
import * as serverPresence from '../../dsh-nodes/lib/ws.mjs'
import { loadConfig } from '../lib/config.mjs'
import { openStore } from '../lib/store.mjs'
import { setLang } from '../lib/i18n.mjs'
import { pairServer, runServer } from '../lib/runner.mjs'

// End-to-end tests bring up the daemon, connect over websocket and execute commands
// inside the sandbox: the GitHub runner has no bwrap, so here they are skipped, while
// locally and on a live host they run in full.
//
// The other reason to skip is the server side: these checks need the epoch protocol. A
// server that still waits for `check_state` ignores our `state` frames, so the loop never
// wakes and the test hangs instead of failing. The presence module of an epoch server
// exports the close codes it uses — that is the capability the client relies on, so it is
// what decides whether the check can run at all.
const EPOCH_SERVER = typeof serverPresence.CLOSE_EPOCH === 'number'
const skip = process.env.CI
  ? { skip: 'нужен bwrap и живой демон' }
  : (EPOCH_SERVER ? {} : { skip: 'the dsh-nodes server here still speaks hello/check_state, not state/epoch' })


const NODES_CONFIG = { routePrefix: '/dsh-nodes', aliveTimeoutSeconds: 60, maxPendingEnroll: 50, maxBodyBytes: 65536 }
const ADMIN = 'admin-token'
let dir
let store
let queue
let server
let base
let config
let controller
let presence

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dshnc-'))
  process.env.DSHNC_HOME = dir
  store = new Store(join(dir, 'nodes.sqlite'))
  const epoch = store.bumpEpoch()
  queue = new Queue({ epoch, defaultTimeout: 5, maxBatch: 5, maxQueue: 100, commandTtl: 300 })
  presence = createPresence({ WebSocketServer, prefix: '/dsh-nodes', store, queue })
  // the server wakes a waiting node from `enqueue`: without this wiring the delivery of a
  // command depends on the race between the test and the client's next poll
  queue.setNotify?.((nodeId) => presence.notify(nodeId))
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

test('the client registers itself, announces shell and executes a command', skip, async () => {
  const lines = []
  // 1. the client goes into the loop: application, waiting, announcement
  const running = runServer({
    url: base,
    config,
    print: (line) => lines.push(line),
    signal: controller.signal,
    pollIdleMs: 10000, // deliberately long: the command must be woken by a state frame
  })

  // 2. wait until the application appears and approve it like a human in the admin UI
  let pending = []
  for (let i = 0; i < 200 && !pending.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    pending = (await admin('/v1/admin/pending')).body.pending
  }
  assert.equal(pending.length, 1, `заявка не появилась; лог клиента: ${lines.join(' | ')}`)
  assert.equal(pending[0].name, config.name)

  const approved = await admin(`/v1/admin/pending/${pending[0].uuid}/approve`, { method: 'POST', body: '{}' })
  assert.equal(approved.status, 200)

  // 3. wait until the client gets the token and announces bash
  let state = live(base)
  for (let i = 0; i < 200 && !state.apiIds?.shell; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    state = live(base)
  }
  assert.ok(state.apiIds?.shell, `клиент не объявился; лог: ${lines.join(' | ')}`)
  assert.ok(state.token, 'токен не сохранён')

  // 4. place a command on behalf of the server and wait for the result
  const node = store.nodes()[0]
  const apiId = store.nodeApis(node.id)[0]
  const { seq, promise } = queue.enqueue({
    nodeId: node.id,
    api: apiId,
    method: 'exec',
    args: { command: 'printf "привет из bash\\n"' },
    timeout: 5,
  })
  const started = Date.now()
  const outcome = await promise
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(Date.now() - started < 5000, 'команда должна доехать по уведомлению, а не по опросу')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(presence.online(node.id), true, 'клиент должен держать WebSocket')
  assert.equal(outcome.status, 'ok', `команда не исполнилась: ${JSON.stringify(outcome)}; лог: ${lines.join(' | ')}`)
  assert.match(outcome.results[0].text, /привет из bash/)

  // 5. the client remembered the server generation (it is named in the announce answer
  // and kept in the state file)
  for (let i = 0; i < 100 && !state.epoch; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    state = live(base)
  }
  assert.ok(state.epoch, 'epoch должен быть сохранён')
})

test('connection state is kept per URL', skip, async () => {
  const state = live(base)
  assert.ok(state.epoch, 'epoch должен быть сохранён')
  assert.ok(state.token, 'токен должен лежать в credentials')
  const other = openStore().readState('http://127.0.0.1:1/other')
  assert.equal(other.epoch, null, 'у другого сервера своё состояние')
})

test('the idle loop does not end by itself: the daemon must live', skip, async () => {
  // Its own server and its own node: a second client on the node already in use is
  // displaced with `4001 replaced` by design, and the displaced instance exits — by
  // mistake that would end this very process instead of testing idleness.
  const idleStore = new Store(join(dir, 'nodes-idle.sqlite'))
  const idleQueue = new Queue({ epoch: idleStore.bumpEpoch(), defaultTimeout: 5 })
  const idlePresence = createPresence({ WebSocketServer, prefix: '/dsh-nodes', store: idleStore, queue: idleQueue })
  idleQueue.setNotify?.((nodeId) => idlePresence.notify(nodeId))
  const idleHandler = createNodesServer({ store: idleStore, queue: idleQueue, config: NODES_CONFIG, adminToken: ADMIN, presence: idlePresence })
  const idleHttp = createServer((req, res) => idleHandler.handle(req, res))
  idleHttp.on('upgrade', (req, socket, head) => idlePresence.upgrade(req, socket, head))
  await new Promise((resolve) => idleHttp.listen(0, '127.0.0.1', resolve))
  const idleBase = `http://127.0.0.1:${idleHttp.address().port}/dsh-nodes`
  try {
    const idleDeps = () => ({ store: idleStore, queue: idleQueue, config: NODES_CONFIG, prefix: '/dsh-nodes', origin: idleBase.replace(/\/dsh-nodes$/, '') })
    const link = await handleAdmin(idleDeps(), 'POST', '/pairing', { ttlSeconds: 600 })
    assert.equal(link.status, 201, 'пара без ссылки не выдаст токен')
    await pairServer({ url: link.body.url, config, print: () => {} })

    // no announcement, no presence new, no work: the most dangerous case for a daemon
    const fresh = new AbortController()
    const running = runServer({ url: idleBase, config, print: () => {}, signal: fresh.signal })
    const outcome = await Promise.race([
      running.then(() => ({ ended: true })),
      new Promise((resolve) => setTimeout(() => resolve({ ended: false }), 600)),
    ])
    fresh.abort()
    await running.catch(() => {})
    assert.equal(outcome.ended, false, 'runServer вышел сам — процесс-демон умрёт на простое')
  } finally {
    idlePresence.close()
    idleHttp.closeAllConnections?.()
    await new Promise((resolve) => idleHttp.close(() => resolve()))
    idleStore.close()
  }
})
