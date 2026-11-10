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

test('session.chdir просит барьер flushAround', async () => {
  const session = await import('../lib/plugins/session.mjs')
  const api = session.api()
  const chdir = api.methods.find((method) => method.method === 'chdir')
  assert.equal(chdir.special, 'flushAround', 'смену каталога нельзя ни обогнать, ни перегнать')
  for (const method of api.methods.filter((item) => item.method !== 'chdir')) {
    assert.equal(method.special ?? null, null, `${method.method} барьер не просит`)
  }
})
