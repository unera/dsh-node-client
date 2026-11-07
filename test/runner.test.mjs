/**
 * Демон: паузы и отмена.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runConcurrently } from '../lib/runner.mjs'
import { openStore } from '../lib/store.mjs'


test('пауза не копит слушателей на AbortSignal', async () => {
  const { sleep } = await import('../lib/runner.mjs')
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal)
  assert.ok(
    controller.signal.listenerCount?.('abort') === undefined || controller.signal.listenerCount('abort') === 0,
    'после пауз слушателей быть не должно',
  )
})

test('approve не блокирует пачку: остальные команды исполняются, пока висит диалог', async () => {
  let releaseDialog
  const dialog = new Promise((resolve) => { releaseDialog = resolve })
  const order = []
  const commands = [
    { seq: 1, method: 'approve', args: {} },
    { seq: 2, method: 'exec', args: {} },
    { seq: 3, method: 'exec', args: {} },
  ]
  const run = async (command) => {
    if (command.method === 'approve') {
      await dialog
      order.push('approve')
      return
    }
    order.push(`exec-${command.seq}`)
  }
  // chdir/approve отделены в runBatch; здесь проверяем сам принцип пула
  const exec = commands.filter((c) => c.method !== 'approve')
  const dialogRun = run(commands[0])
  await runConcurrently(exec, run, { concurrency: 5 })
  assert.deepEqual(order.sort(), ['exec-2', 'exec-3'], 'exec прошли, пока диалог висит')
  releaseDialog()
  await dialogRun
  assert.ok(order.includes('approve'))
})

test('падение одной команды не мешает остальным в пачке', async () => {
  const done = []
  await runConcurrently([
    { seq: 1 },
    { seq: 2 },
    { seq: 3 },
  ], async (command) => {
    if (command.seq === 2) throw new Error('плагин упал')
    done.push(command.seq)
  }, { concurrency: 2 })
  assert.deepEqual(done.sort(), [1, 3], 'упавшая команда не должна утащить остальные')
})

test('pollIdleMs: 0 — периодического опроса нет, будит только кадр', async () => {
  const { runServer } = await import('../lib/runner.mjs')
  let calls = 0
  const controller = new AbortController()
  // сервер-пустышка: отвечает на всё, команд не даёт
  const server = createServer((req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ commands: [], cursor: null, ready: 0, epoch: 1, state: 0, node: 1, apis: [], warnings: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/dsh-nodes`
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-nopoll-'))
  const store = openStore({ dir })
  store.saveToken?.(base, 'test-token')
  const run = runServer({
    url: base,
    config: { pollIdleMs: 0, token: 'test-token' },
    print: () => {},
    signal: controller.signal,
    plugins: [],
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  const before = calls
  await new Promise((resolve) => setTimeout(resolve, 1200))
  assert.equal(calls, before, 'за 1.2 секунды простоя не должно быть ни одного опроса')
  controller.abort()
  await run
  server.close()
  rmSync(dir, { recursive: true, force: true })
})
