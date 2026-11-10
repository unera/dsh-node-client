import assert from 'node:assert/strict'
import { test } from 'node:test'


test('session.ping отвечает ok даже без хранилища сессий', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const answer = await session.handle({ method: 'ping', args: {} }, {})
  assert.equal(answer.ok, true)
  const payload = JSON.parse(answer.results[0].text)
  assert.equal(typeof payload.pong, 'number')
  assert.equal(payload.platform, process.platform)
  assert.match(payload.version, /^desktop-\d+\.\d+\.\d+$/)
})

test('session.ping объявлен в API и версия контракта поднята', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const api = session.api()
  assert.ok(api.methods.some((method) => method.method === 'ping'))
  // версия API = версия клиента: разные платформы не сталкиваются по ключу
  assert.match(api.version, /^desktop-\d+\.\d+\.\d+$/, 'версия API должна быть версией клиента')
})

test('session.id отдаёт номер сессии, в которой пришла команда', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const answer = await session.handle(
    { method: 'id', args: {}, session: 'session-a7fd5961-4be0-4120-a7e6-a4f3507cac11' },
    {},
  )
  const payload = JSON.parse(answer.results[0].text)
  assert.equal(payload.session, 'session-a7fd5961-4be0-4120-a7e6-a4f3507cac11')
})

test('session.id без сессии возвращает null, а не выдумку', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const answer = await session.handle({ method: 'id', args: {} }, {})
  const payload = JSON.parse(answer.results[0].text)
  assert.equal(payload.session, null)
})

test('session.chdir просит барьер flushAround — отдельным списком правил', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const api = session.api()
  // в самом объявлении метода правил нет: они едут в announce.applyRules
  for (const method of api.methods) {
    assert.equal(method.special ?? null, null, `${method.method}: правило не должно жить в apidef`)
  }
  assert.deepEqual(api.rules, [{ method: 'chdir', rule: 'flushAround' }])
})

test('правила плагинов собираются в announce.applyRules с именем API', async () => {
  const { rulesOf } = await import('../lib/plugins/index.mjs')
  const plugins = [
    { api: { name: 'session', rules: [{ method: 'chdir', rule: 'flushAround' }] } },
    { api: { name: 'bash' } },
    { api: { name: 'shell', rules: [{ method: 'ping', rule: 'timing', rulesOpts: { retNames: { durationMs: 'took' } } }] } },
  ]
  assert.deepEqual(rulesOf(plugins), [
    { api: 'session', method: 'chdir', rule: 'flushAround' },
    { api: 'shell', method: 'ping', rule: 'timing', rulesOpts: { retNames: { durationMs: 'took' } } },
  ])
})

test('объявление несёт applyRules отдельным полем, а не в apidef', async () => {
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ apis: [], epoch: 1, warnings: [] }) }
  }
  try {
    const api = await import('../lib/api.mjs')
    await api.announce('http://example.invalid', 'token', [{ name: 'session', version: 'v', methods: [] }], {
      applyRules: [{ api: 'session', method: 'chdir', rule: 'flushAround' }],
    })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.deepEqual(calls[0].body.applyRules, [{ api: 'session', method: 'chdir', rule: 'flushAround' }])
  // в самом объявлении API служебных полей нет
  assert.deepEqual(calls[0].body.apis[0], { name: 'session', version: 'v', methods: [] })
})

test('результат уносит часы узла в конверте', async () => {
  const { readFileSync } = await import('node:fs')
  const runner = readFileSync(new URL('../lib/runner.mjs', import.meta.url), 'utf8')
  // `now` — простой факт об ответе, а не знание о правилах: правило читает его,
  // только когда считает смещение часов
  assert.match(runner, /now: preciseNow\(\)/, 'конверт результата должен нести часы узла')
})
