import assert from 'node:assert/strict'
import { test } from 'node:test'


test('session.ping answers ok even without a session store', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const answer = await session.handle({ method: 'ping', args: {} }, {})
  assert.equal(answer.ok, true)
  const payload = JSON.parse(answer.results[0].text)
  // the node no longer takes its own measurements: they are computed by the timing rule on the server
  assert.equal(payload.pong ?? null, null)
  assert.equal(typeof payload.upSeconds, 'number')
  assert.equal(payload.platform, process.platform)
  assert.match(payload.version, /^desktop-\d+\.\d+\.\d+$/)
})

test('session.ping is declared in the API and the contract version is bumped', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const api = session.api()
  assert.ok(api.methods.some((method) => method.method === 'ping'))
  // the API version equals the client version: different platforms do not collide on the key
  assert.match(api.version, /^desktop-\d+\.\d+\.\d+$/, 'версия API должна быть версией клиента')
})

test('session.id returns the number of the session the command came in', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const answer = await session.handle(
    { method: 'id', args: {}, session: 'session-a7fd5961-4be0-4120-a7e6-a4f3507cac11' },
    {},
  )
  const payload = JSON.parse(answer.results[0].text)
  assert.equal(payload.session, 'session-a7fd5961-4be0-4120-a7e6-a4f3507cac11')
})

test('session.id without a session returns null, not an invention', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const answer = await session.handle({ method: 'id', args: {} }, {})
  const payload = JSON.parse(answer.results[0].text)
  assert.equal(payload.session, null)
})

test('session.chdir asks for the flushAround barrier via a separate rules list', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const api = session.api()
  // the method declaration itself has no rules: they travel in announce.applyRules
  for (const method of api.methods) {
    assert.equal(method.special ?? null, null, `${method.method}: правило не должно жить в apidef`)
  }
  assert.deepEqual(api.rules, [
    { method: 'chdir', rule: 'flushAround' },
    // the ping is measured by the server: duration by its own marks, offset by the node clock
    {
      method: 'ping',
      rule: 'timing',
      rulesOpts: { retNames: { durationMs: 'durationMs', clockSkewMs: 'clockSkewMs' } },
    },
  ])
})

test('plugin rules are collected into announce.applyRules with the API name', async () => {
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

test('the announcement carries applyRules as a separate field, not inside apidef', async () => {
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
  // the API announcement itself has no internal fields
  assert.deepEqual(calls[0].body.apis[0], { name: 'session', version: 'v', methods: [] })
})

