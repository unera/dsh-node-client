/**
 * Поведенческие тесты проводки клиента: настоящий цикл, фейковый сервер.
 *
 * Здесь проверяется то, что раньше «проверялось» поиском строк в исходнике:
 * уходит ли `now` в конверте, пишется ли строка про осиротевший результат,
 * отвечает ли барьер FLUSH через настоящий пул, попадает ли `conn` в hello,
 * и как маршрутизируются служебные имена.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolvePlugin } from '../lib/plugins/index.mjs'
import { runServer } from '../lib/runner.mjs'
import { openStore } from '../lib/store.mjs'
import { startFakeNode, waitFor } from './helpers/fake-node.mjs'

const execPlugin = {
  api: { name: 'shell', version: 'test-1', methods: [{ method: 'exec', args: { type: 'object' } }] },
  async handle () {
    await new Promise((resolve) => setTimeout(resolve, 120))
    return { ok: true, results: [{ type: 'text', text: 'готово' }] }
  },
  async handleControl (command, ctx) {
    if (command.method === '#INTERNAL.FLUSH') {
      await ctx.drain?.()
      return { ok: true, results: [{ type: 'text', text: JSON.stringify({ flushed: true }) }] }
    }
    return { ok: true, results: [] }
  },
}

/**
 * Поднять клиента против фейкового сервера и гарантированно всё убрать.
 * @param {object} options параметры фейкового сервера
 * @param {(fake: object, client: {printed: string[]}) => Promise<void>} body проверка
 */
async function withNode (options, body) {
  const fake = await startFakeNode(options)
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-behaviour-'))
  const previousHome = process.env.DSHNC_HOME
  process.env.DSHNC_HOME = dir
  const store = openStore()
  store.setToken(fake.url, 'test-token')
  const controller = new AbortController()
  const printed = []
  const run = runServer({
    url: fake.url,
    config: { token: 'test-token' },
    print: (line) => printed.push(line),
    signal: controller.signal,
    plugins: [execPlugin],
  })
  try {
    await body(fake, { printed, store, url: fake.url })
  } finally {
    controller.abort()
    await run.catch(() => {})
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
}

test('конверт результата несёт часы узла', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.results.length > 0), 'клиент должен отправить результат')
    assert.equal(typeof fake.calls.results[0].body.now, 'number', 'часы узла едут в конверте, а не в тексте')
    const hello = fake.calls.frames.find((frame) => frame.t === 'hello')
    assert.ok(hello, 'клиент должен здороваться')
    assert.equal(typeof hello.conn, 'number', 'номер соединения нужен серверу, чтобы не было двух клиентов')
  })
})

test('осиротевший результат попадает в лог, а не теряется молча', async () => {
  await withNode({
    commands: [{ seq: 2, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
    resultStatus: 409,
  }, async (fake, client) => {
    assert.ok(
      await waitFor(() => client.printed.some((line) => /\b2\b/.test(line) && /осиротел|orphaned/i.test(line))),
      `ожидали строку про осиротевшую команду, а в логе: ${client.printed.join(' | ')}`,
    )
  })
})

test('барьер FLUSH отвечает через настоящий пул и не запирает себя', async () => {
  await withNode({
    commands: [
      { seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } },
      { seq: 2, api: -1, method: '#INTERNAL.FLUSH', args: {}, timeout: 10, sandbox: { mode: 'rw' } },
    ],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.results.length >= 2), 'обе команды должны ответить')
    const flush = fake.calls.results.find((entry) => entry.seq === 2)
    assert.ok(flush, 'барьер обязан ответить, а не висеть на себе')
    assert.equal(flush.body.ok, true)
    const flushAt = fake.calls.results.findIndex((entry) => entry.seq === 2)
    const execAt = fake.calls.results.findIndex((entry) => entry.seq === 1)
    assert.ok(flushAt > execAt, 'барьер отвечает после работы, а не раньше')
  })
})

test('служебное имя уходит в handleControl, обычное — в handle', () => {
  const other = { api: { name: 'other', methods: [{ method: 'plain' }] }, async handle () { return { ok: true } } }
  const plugins = [execPlugin, other]
  assert.equal(resolvePlugin(plugins, { method: '#INTERNAL.CANCEL', api: -1 }), execPlugin, 'решётка — всегда служебный обработчик')
  assert.equal(resolvePlugin(plugins, { method: 'exec', api: 1 }, { shell: 1 }), execPlugin, 'обычное имя — по объявлению')
})

test('разрыв сокета не превращается в опрос: клиент переподключается', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.frames.some((frame) => frame.t === 'hello')), 'сначала здороваемся')
    // сервер рвёт сокет — клиент обязан открыть новый, а не начать опрашивать
    fake.dropSockets()
    assert.ok(
      await waitFor(() => fake.calls.frames.filter((frame) => frame.t === 'hello').length >= 2, { timeoutMs: 6000 }),
      'после разрыва клиент должен переподключиться и поздороваться заново',
    )
  })
})

test('повтор после ошибки выдерживает паузу, а не крутится по кадру сокета', async () => {
  // Сначала сервер живой: клиент объявляется и держит сокет. Потом «прокси»
  // начинает отдавать 404 HTML и рвёт соединение — именно тогда старый код
  // (пауза, прерываемая кадром сокета) уходил в плотный цикл.
  await withNode({}, async (fake, client) => {
    assert.ok(await waitFor(() => fake.calls.frames.some((frame) => frame.t === 'hello')), 'клиент должен подключиться')

    const brokenAt = Date.now()
    fake.breakHttp()
    fake.dropSockets()

    // ждём, пока наберётся несколько попыток после поломки
    await waitFor(() => fake.calls.requests.filter((entry) => entry.at > brokenAt).length >= 3, { timeoutMs: 12_000 })
    const attempts = fake.calls.requests.filter((entry) => entry.at > brokenAt).map((entry) => entry.at)
    assert.ok(attempts.length >= 2, `ожидали повторы, а их ${attempts.length}`)

    // ни одна пауза не должна быть короче секунды: backoff идёт 1 → 2 → 4 с
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index])
    for (const gap of gaps) {
      assert.ok(gap >= 800, `пауза не выдержана: ${gaps.join(', ')} мс`)
    }
    // и пауза обязана РАСТИ. Старый код (пауза, прерываемая кадром сокета)
    // тоже давал ~1 с между попытками, но никогда не удлинял её; замерено:
    // новый — 1029 и 2029 мс, старый — 1017, 1034, 1020, 1023...
    assert.ok(
      Math.max(...gaps) >= 1500,
      `backoff должен удлинять паузу, а интервалы: ${gaps.join(', ')} мс`,
    )
    assert.ok(gaps.length <= 3, `за это время попыток больше, чем велит backoff: ${gaps.join(', ')} мс`)
    assert.ok(
      client.printed.some((line) => /ответ не JSON|not JSON/i.test(line)),
      `в логе должно быть сказано про не-JSON ответ, а там: ${client.printed.join(' | ')}`,
    )
  })
})

test('401 без JSON не стирает токен узла', async () => {
  // nginx basic-auth или Cloudflare отвечают 401 HTML: это не «токен не тот»,
  // и терять привязку из-за прокси нельзя
  const fake = await startFakeNode({})
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-401-'))
  const previousHome = process.env.DSHNC_HOME
  process.env.DSHNC_HOME = dir
  const store = openStore()
  store.setToken(fake.url, 'secret-token')
  // сервер отвечает 401 HTML на всё (так ведёт себя basic-auth за прокси)
  fake.breakHttp(401)
  const controller = new AbortController()
  const printed = []
  const run = runServer({ url: fake.url, config: { token: 'secret-token' }, print: (line) => printed.push(line), signal: controller.signal, plugins: [execPlugin] })
  try {
    await waitFor(() => printed.length > 0, { timeoutMs: 5000 })
    assert.equal(store.token(fake.url), 'secret-token', 'токен должен остаться: 401 от прокси — не отказ узла')
  } finally {
    controller.abort()
    await run.catch(() => {})
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})
