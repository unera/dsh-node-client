/**
 * Подключение по ссылке с кодом: админ жмёт «подключить клиента», клиент
 * запускает `dshnc connect <ссылка>` и сразу получает токен.
 *
 * Проверяем настоящим сервером плагина: код выдаётся, гасится, второй раз не
 * работает, а клиент после этого объявляет свой API и исполняет команду.
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
import { createPresence } from '../../dsh-nodes/lib/ws.mjs'
import { loadConfig, serverState } from '../lib/config.mjs'
import { pairServer, runServer } from '../lib/runner.mjs'
import { setLang } from '../lib/i18n.mjs'
import { loadPlugins } from '../lib/plugins/index.mjs'

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

async function admin (path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...options.headers },
  })
  return { status: response.status, body: await response.json() }
}

test('ссылка из админки подключает клиента без подтверждения', async () => {
  const link = await admin('/v1/admin/pairing', { method: 'POST', body: JSON.stringify({ ttlSeconds: 600 }) })
  assert.equal(link.status, 201)
  assert.match(link.body.url, /\?v=/)

  const printed = []
  await pairServer({ url: link.body.url, config, print: (line) => printed.push(line) })
  const state = serverState(config, base)
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

test('после подключения клиент объявляет плагины и исполняет команду', async () => {
  const state = serverState(config, base)
  const plugins = await loadPlugins({ dir: join(dir, 'plugins') })
  assert.deepEqual(plugins.map((plugin) => plugin.api.name), ['bash'])

  const running = runServer({ url: base, config, print: () => {}, signal: controller.signal, pollIdleMs: 200, plugins })

  for (let i = 0; i < 100 && !state.apiIds?.bash; i++) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(state.apiIds?.bash, 'клиент должен объявить API')
  assert.equal(state.apiIds.bash, store.nodeApis(state.node)[0])

  const node = store.node(state.node)
  const apiId = store.nodeApis(node.id)[0]
  const { promise } = queue.enqueue({ nodeId: node.id, api: apiId, method: 'exec', args: { command: 'echo pairing-ok' }, timeout: 5 })
  const outcome = await promise
  assert.equal(outcome.status, 'ok')
  assert.match(outcome.results[0].text, /pairing-ok/)
})
