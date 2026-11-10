/**
 * Daemon: pauses and cancellation.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPool } from '../lib/runner.mjs'
import { openStore } from '../lib/store.mjs'


test('pause does not accumulate listeners on AbortSignal', async () => {
  const { sleep } = await import('../lib/runner.mjs')
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal)
  assert.ok(
    controller.signal.listenerCount?.('abort') === undefined || controller.signal.listenerCount('abort') === 0,
    'после пауз слушателей быть не должно',
  )
})

test('pool keeps its ceiling and knows how many slots are free', async () => {
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

test('whenFree waits for at least one slot to be released, not for all of them', async () => {
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

test('whenIdle is a barrier: empty only when it is really empty', async () => {
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

test('a failed command neither drops the pool nor holds a slot forever', async () => {
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

test('there is no polling at all: only a frame wakes it up, even if an old config asks for polling', async () => {
  const { runServer } = await import('../lib/runner.mjs')
  let calls = 0
  const controller = new AbortController()
  // dummy server: answers everything, hands out no commands
  const server = createServer((req, res) => {
    calls++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ commands: [], ready: 0, epoch: 1, node: 1, apis: [], warnings: [] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}/dsh-nodes`
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-nopoll-'))
  const store = openStore({ dir })
  store.setToken(base, 'test-token')
  const run = runServer({
    url: base,
    // a key from old configs: it means nothing any more
    config: { pollIdleMs: 5000, token: 'test-token' },
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

test('wakeup gate: a frame that arrives before the wait is not lost', async () => {
  const { createWakeGate } = await import('../lib/runner.mjs')
  const gate = createWakeGate()
  // the frame arrived before the loop went to sleep - that was the deadlock
  gate.nudge()
  assert.equal(gate.take(), true, 'событие должно запомниться')
  assert.equal(gate.take(), false, 'и использоваться ровно один раз')
})

test('wakeup gate: the wait is woken by a frame', async () => {
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

test('wakeup gate: two frames in a row are not swallowed', async () => {
  const { createWakeGate } = await import('../lib/runner.mjs')
  const gate = createWakeGate()
  gate.nudge()
  gate.nudge()
  assert.equal(gate.take(), true)
  assert.equal(gate.take(), false, 'лишний кадр — не повод крутиться вечно')
})

test('409 on result submission means "too late", not an error', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ code: 'bad_request', message: 'команда 14 уже закрыта' }),
  })
  try {
    const api = await import('../lib/api.mjs')
    const response = await api.result('http://example.invalid', 'token', 14, { ok: true })
    assert.equal(response.body.late, true, 'клиент должен понять, что опоздал, а не падать')
  } finally {
    globalThis.fetch = realFetch
  }
})



test('the barrier does not wait for itself and does not answer before the work is done', async () => {
  const { createPool } = await import('../lib/runner.mjs')

  // pool 1: a single barrier - nothing to wait for, it answers at once
  const solo = createPool({ slots: 1, run: async (command) => { if (command.method === '#F') await solo.whenIdle(1) } })
  const started = Date.now()
  await Promise.race([solo.submit({ seq: 1, method: '#F' }), new Promise((r) => setTimeout(r, 1000))])
  assert.ok(Date.now() - started < 500, 'барьер не должен ждать самого себя')

  // pool 2: the barrier must let long work go first and wait for it
  const order = []
  const pool = createPool({ slots: 2, run: async (command) => {
    if (command.method === '#F') { await pool.whenIdle(1); order.push('flush') }
    else { await new Promise((r) => setTimeout(r, 200)); order.push('exec') }
  } })
  pool.submit({ seq: 1, method: 'exec' })
  pool.submit({ seq: 2, method: '#F' })
  await pool.whenIdle()
  assert.deepEqual(order, ['exec', 'flush'], 'барьер отвечает только после работы до него')
})

test('there is no cursor adoption any more: the client reports only its own numbers', async () => {
  const runner = await import('../lib/runner.mjs')
  // the old `adoptMaxCommandno` took the number from the server and closed the holes of a
  // cancelled command with it. With the cursor gone that knowledge has nowhere to live
  assert.equal(runner.adoptMaxCommandno, undefined, 'принятие номера от сервера удалено вместе с курсором')
})
