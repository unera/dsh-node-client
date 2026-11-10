/**
 * Behavioural tests of the client wiring: a real loop, a fake server.
 *
 * This checks what used to be "checked" by searching for strings in the source:
 * whether `now` goes into the envelope, whether the line about an orphaned result is written,
 * whether the FLUSH barrier answers through the real pool, whether `conn` gets into hello,
 * and how internal names are routed.
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
 * Bring up the client against the fake server and make sure everything is torn down.
 * @param {object} options fake server options
 * @param {(fake: object, client: {printed: string[]}) => Promise<void>} body the check
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
    // stopping the client must not hang the test: if run did not finish within 5 s,
    // that is a client defect and must be reported, not hang until the CI timeout
    const stopped = await Promise.race([
      run.then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!stopped) {
      assert.fail(`клиент не остановился по abort за 5 секунд; последнее в логе: ${printed.slice(-3).join(' | ')}`)
    }
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
}

test('result envelope carries the node clock', async () => {
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

test('orphaned result goes to the log instead of being lost silently', async () => {
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

test('FLUSH barrier answers through the real pool and does not lock itself up', async () => {
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

test('internal name goes to handleControl, ordinary one to handle', () => {
  const other = { api: { name: 'other', methods: [{ method: 'plain' }] }, async handle () { return { ok: true } } }
  const plugins = [execPlugin, other]
  assert.equal(resolvePlugin(plugins, { method: '#INTERNAL.CANCEL', api: -1 }), execPlugin, 'решётка — всегда служебный обработчик')
  assert.equal(resolvePlugin(plugins, { method: 'exec', api: 1 }, { shell: 1 }), execPlugin, 'обычное имя — по объявлению')
})

test('socket drop does not turn into polling: the client reconnects', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.frames.some((frame) => frame.t === 'hello')), 'сначала здороваемся')
    // the server drops the socket - the client must open a new one, not start polling
    fake.dropSockets()
    assert.ok(
      await waitFor(() => fake.calls.frames.filter((frame) => frame.t === 'hello').length >= 2, { timeoutMs: 6000 }),
      'после разрыва клиент должен переподключиться и поздороваться заново',
    )
  })
})

test('retry after an error keeps the pause instead of spinning per socket frame', async () => {
  // First the server is alive: the client announces itself and holds the socket. Then the "proxy"
  // starts serving 404 HTML and drops the connection - that is when the old code
  // (a pause interrupted by a socket frame) went into a tight loop.
  await withNode({}, async (fake, client) => {
    assert.ok(await waitFor(() => fake.calls.frames.some((frame) => frame.t === 'hello')), 'клиент должен подключиться')

    const brokenAt = Date.now()
    fake.breakHttp()
    fake.dropSockets()

    // wait until several attempts have accumulated after the breakage
    await waitFor(() => fake.calls.requests.filter((entry) => entry.at > brokenAt).length >= 3, { timeoutMs: 12_000 })
    const attempts = fake.calls.requests.filter((entry) => entry.at > brokenAt).map((entry) => entry.at)
    assert.ok(attempts.length >= 2, `ожидали повторы, а их ${attempts.length}`)

    // no pause may be shorter than a second: backoff goes 1 -> 2 -> 4 s
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index])
    for (const gap of gaps) {
      assert.ok(gap >= 800, `пауза не выдержана: ${gaps.join(', ')} мс`)
    }
    // and the pause must GROW. The old code (a pause interrupted by a socket frame)
    // also gave ~1 s between attempts, but never lengthened it; measured:
    // the new one - 1029 and 2029 ms, the old one - 1017, 1034, 1020, 1023...
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

test('401 without JSON does not wipe the node token', async () => {
  // nginx basic-auth or Cloudflare answer with 401 HTML: this is not "the token is wrong",
  // and the pairing must not be lost because of a proxy
  const fake = await startFakeNode({})
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-401-'))
  const previousHome = process.env.DSHNC_HOME
  process.env.DSHNC_HOME = dir
  const store = openStore()
  store.setToken(fake.url, 'secret-token')
  // the server answers 401 HTML to everything (this is how basic-auth behaves behind a proxy)
  fake.breakHttp(401)
  const controller = new AbortController()
  const printed = []
  const run = runServer({ url: fake.url, config: { token: 'secret-token' }, print: (line) => printed.push(line), signal: controller.signal, plugins: [execPlugin] })
  try {
    await waitFor(() => printed.length > 0, { timeoutMs: 5000 })
    assert.equal(store.token(fake.url), 'secret-token', 'токен должен остаться: 401 от прокси — не отказ узла')
  } finally {
    controller.abort()
    // stopping the client must not hang the test: if run did not finish within 5 s,
    // that is a client defect and must be reported, not hang until the CI timeout
    const stopped = await Promise.race([
      run.then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!stopped) assert.fail('клиент не остановился по abort за 5 секунд')
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restart is declared once: null in hello and in the first check_state, then numbers', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.results.length > 0), 'the client must execute the command')
    const hello = fake.calls.frames.find((frame) => frame.t === 'hello')
    assert.ok(hello, 'hello must be sent')
    assert.equal(hello.known, null, 'a fresh process declares the restart in hello')

    const checks = fake.calls.frames.filter((frame) => frame.t === 'check_state')
    assert.equal(checks[0]?.known, null, 'the first wait frame repeats the declaration — the server reacts to it, not to hello')
    const nulls = checks.filter((frame) => frame.known === null)
    assert.equal(nulls.length, 1, `exactly one null frame is allowed, got ${nulls.length}: ${JSON.stringify(checks.map((c) => c.known))}`)
    assert.ok(checks.slice(1).every((frame) => typeof frame.known === 'number'), 'every later frame carries a number')
  })
})
