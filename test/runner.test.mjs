/**
 * Демон: паузы и отмена.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPool } from '../lib/runner.mjs'
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

test('пул держит потолок и знает, сколько слотов свободно', async () => {
  let peak = 0
  let live = 0
  const finished = []
  const pool = createPool({
    slots: 2,
    run: async (command) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((resolve) => setTimeout(resolve, 5))
      live -= 1
      finished.push(command.seq)
    },
  })
  for (const seq of [1, 2, 3, 4]) pool.submit({ seq })
  assert.equal(pool.busy, 2, 'занято ровно столько, сколько слотов')
  assert.equal(pool.free, 0, 'пока обе задачи идут, свободных слотов нет')
  await pool.whenIdle()
  assert.equal(peak, 2, 'одновременно не больше двух команд')
  assert.deepEqual(finished.sort(), [1, 2, 3, 4], 'все команды дошли до конца')
  assert.equal(pool.busy, 0)
})

test('whenFree ждёт освобождения хотя бы одного слота, not все сразу', async () => {
  const pool = createPool({
    slots: 2,
    run: (command) => new Promise((resolve) => setTimeout(resolve, command.ms)),
  })
  pool.submit({ seq: 1, ms: 10 })
  pool.submit({ seq: 2, ms: 60 })
  assert.equal(pool.free, 0)
  const started = Date.now()
  await pool.whenFree()
  const spent = Date.now() - started
  assert.ok(spent < 50, `ждали один слот, а не оба: ${spent} мс`)
  assert.equal(pool.free, 1)
  await pool.whenIdle()
})

test('whenIdle — это барьер: пусто только когда пусто', async () => {
  const pool = createPool({
    slots: 3,
    run: (command) => new Promise((resolve) => setTimeout(resolve, command.ms)),
  })
  pool.submit({ seq: 1, ms: 20 })
  pool.submit({ seq: 2, ms: 30 })
  let idle = false
  const waiting = pool.whenIdle().then(() => { idle = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(idle, false, 'пока команды идут, пул не пуст')
  await waiting
  assert.equal(idle, true)
})

test('падение команды не роняет пул и не занимает слот навсегда', async () => {
  const done = []
  const pool = createPool({
    slots: 2,
    run: async (command) => {
      if (command.seq === 2) throw new Error('плагин упал')
      done.push(command.seq)
    },
  })
  await Promise.all([pool.submit({ seq: 1 }), pool.submit({ seq: 2 }), pool.submit({ seq: 3 })])
  assert.deepEqual(done.sort(), [1, 3], 'упавшая команда не утащила остальные')
  assert.equal(pool.busy, 0, 'слот вернулся')
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

test('ворота пробуждения: кадр до ожидания не теряется', async () => {
  const { createWakeGate } = await import('../lib/runner.mjs')
  const gate = createWakeGate()
  // кадр пришёл раньше, чем цикл собрался спать — это и был мёртвый лок
  gate.nudge()
  assert.equal(gate.take(), true, 'событие должно запомниться')
  assert.equal(gate.take(), false, 'и использоваться ровно один раз')
})

test('ворота пробуждения: ожидание будится кадром', async () => {
  const { createWakeGate } = await import('../lib/runner.mjs')
  const gate = createWakeGate()
  let woke = false
  const waiting = gate.wait().then(() => { woke = true })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(woke, false, 'без кадра не просыпаемся')
  gate.nudge()
  await waiting
  assert.equal(woke, true)
  assert.equal(gate.take(), true, 'после пробуждения отметка ждёт следующего ожидания')
})

test('ворота пробуждения: два кадра подряд не съедаются', async () => {
  const { createWakeGate } = await import('../lib/runner.mjs')
  const gate = createWakeGate()
  gate.nudge()
  gate.nudge()
  assert.equal(gate.take(), true)
  assert.equal(gate.take(), false, 'лишний кадр — не повод крутиться вечно')
})
