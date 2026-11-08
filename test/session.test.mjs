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
  assert.equal(api.version, '4', 'новый метод — новая версия контракта')
})
