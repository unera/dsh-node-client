/**
 * Сквозной тест клиента: настоящий цикл `runServer` против настоящего сервера
 * плагина. Проверяем то, ради чего всё писалось: команда доезжает до машины,
 * bash исполняется, результат возвращается ожидающему.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { Store } from '../../dsh-nodes/lib/db.mjs'
import { Queue } from '../../dsh-nodes/lib/queue.mjs'
import { createNodesServer } from '../../dsh-nodes/lib/server.mjs'
import { loadConfig, serverState } from '../lib/config.mjs'
import { runServer } from '../lib/runner.mjs'

const ADMIN = 'admin-token'
let dir
let store
let queue
let server
let base
let config
let controller

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dshnc-'))
  process.env.DSHNC_HOME = dir
  store = new Store(join(dir, 'nodes.sqlite'))
  const epoch = store.bumpEpoch()
  queue = new Queue({ epoch, defaultTimeout: 5, maxBatch: 5, maxQueue: 100, commandTtl: 300 })
  const handler = createNodesServer({
    store,
    queue,
    config: { routePrefix: '/dsh-nodes', maxBodyBytes: 65536, aliveTimeoutSeconds: 60, maxPendingEnroll: 50 },
    adminToken: ADMIN,
  })
  server = createServer((req, res) => handler.handle(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}/dsh-nodes`

  config = loadConfig()
  controller = new AbortController()
})

after(() => {
  controller?.abort()
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

test('клиент регистрируется сам, объявляет bash и исполняет команду', async () => {
  const lines = []
  // 1. клиент уходит в цикл: заявка, ожидание, объявление
  const running = runServer({
    url: base,
    config,
    print: (line) => lines.push(line),
    signal: controller.signal,
    pollIdleMs: 50,
  })

  // 2. ждём, пока заявка появится, и одобряем её как человек в админке
  let pending = []
  for (let i = 0; i < 50 && !pending.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    pending = (await admin('/v1/admin/pending')).body.pending
  }
  assert.equal(pending.length, 1, `заявка не появилась; лог клиента: ${lines.join(' | ')}`)
  assert.equal(pending[0].name, config.name)

  const approved = await admin(`/v1/admin/pending/${pending[0].uuid}/approve`, { method: 'POST', body: '{}' })
  assert.equal(approved.status, 200)

  // 3. ждём, пока клиент получит токен и объявит bash
  const state = serverState(config, base)
  for (let i = 0; i < 100 && !state.announced; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(state.announced, `клиент не объявился; лог: ${lines.join(' | ')}`)
  assert.ok(state.token, 'токен не сохранён')

  // 4. ставим команду от лица сервера и ждём результата
  const node = store.nodes()[0]
  const apiId = store.nodeApis(node.id)[0]
  const { seq, promise } = queue.enqueue({
    nodeId: node.id,
    api: apiId,
    method: 'exec',
    args: { command: 'printf "привет из bash\\n"' },
    timeout: 5,
  })
  const outcome = await promise
  assert.equal(outcome.status, 'ok', `команда не исполнилась: ${JSON.stringify(outcome)}; лог: ${lines.join(' | ')}`)
  assert.match(outcome.results[0].text, /привет из bash/)

  // 5. курсор клиента уехал на номер команды (клиент пишет его после ответа)
  for (let i = 0; i < 40 && state.cursor !== seq; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(state.cursor, seq)
})

test('состояние соединения сохраняется per URL', async () => {
  const state = serverState(config, base)
  assert.ok(state.epoch, 'epoch должен быть сохранён')
  assert.ok(state.cursor >= 1, 'курсор должен пережить шаг цикла')
  assert.ok(state.token, 'токен должен лежать в конфиге')
  const other = serverState(config, 'http://127.0.0.1:1/other')
  assert.equal(other.cursor, null, 'у другого сервера своё состояние')
})
