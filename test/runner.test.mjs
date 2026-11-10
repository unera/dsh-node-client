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

test('409 на отправке результата — это «поздно», а не ошибка', async () => {
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

test('об осиротевшей команде клиент пишет в лог', async () => {
  const { readFileSync } = await import('node:fs')
  const runner = readFileSync(new URL('../lib/runner.mjs', import.meta.url), 'utf8')
  assert.match(runner, /run\.orphanResult/, 'молчать про отброшенный результат нельзя')
  const { t } = await import('../lib/i18n.mjs')
  const line = t('run.orphanResult', { seq: 14, method: 'exec' })
  assert.match(line, /14/)
  assert.match(line, /exec/)
  // русская строка живёт рядом, в словаре; t() без языка отдаёт английскую
  const dict = readFileSync(new URL('../lib/i18n.mjs', import.meta.url), 'utf8')
  assert.match(dict, /осиротела/, 'у строки должен быть русский вариант')
})

test('подписка ставится до вопроса о состоянии', async () => {
  const { readFileSync } = await import('node:fs')
  const runner = readFileSync(new URL('../lib/runner.mjs', import.meta.url), 'utf8')
  const branch = runner.slice(runner.indexOf('if (!commands.length) {'))
  const sleepingAt = branch.indexOf('const sleeping = waitForWake()')
  const askAt = branch.indexOf('presence?.sendAlive')
  assert.ok(sleepingAt > -1 && askAt > -1, 'ожидание и вопрос должны быть в этой ветке')
  // в websocket у нас состояние, а не событие: ответ на вопрос может прийти
  // сразу, поэтому слушатель обязан быть готов раньше вопроса
  assert.ok(sleepingAt < askAt, 'сначала подписка, потом check_state — иначе ответ упадёт в пустоту')
})

test('барьер не ждёт сам себя и не отвечает раньше работы', async () => {
  const { createPool } = await import('../lib/runner.mjs')

  // пул 1: барьер один — ждать нечего, отвечает сразу
  const solo = createPool({ slots: 1, run: async (command) => { if (command.method === '#F') await solo.whenIdle(1) } })
  const started = Date.now()
  await Promise.race([solo.submit({ seq: 1, method: '#F' }), new Promise((r) => setTimeout(r, 1000))])
  assert.ok(Date.now() - started < 500, 'барьер не должен ждать самого себя')

  // пул 2: барьер обязан пропустить вперёд долгую работу и дождаться её
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

test('клиент принимает номер, который назвал сервер — так закрываются дырки', async () => {
  const { adoptMaxCommandno } = await import('../lib/runner.mjs')
  // сервер выдал 1..4 и сжёг 5 на отменённую команду: максимум по полученным — 4,
  // но сервер называет 5, и клиент обязан это принять
  assert.equal(adoptMaxCommandno(4, 5), 5)
  assert.equal(adoptMaxCommandno(57, 54), 57, 'назад номер не едет: приоритетная отмена приходит раньше низких')
  assert.equal(adoptMaxCommandno(null, 5), 5, 'первый ответ тоже принимается')
  assert.equal(adoptMaxCommandno(5, undefined), 5, 'мусор в поле ничего не ломает')
  assert.equal(adoptMaxCommandno(5, 'нет'), 5)
})
