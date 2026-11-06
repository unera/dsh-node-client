/**
 * Хранилище клиента: настройки, токены и рантайм — в разных местах.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../lib/store.mjs'

const URL_A = 'https://dsh.uvw.ru/dsh-nodes'
const URL_B = 'http://127.0.0.1:3080/dsh-nodes'

test('настройки, токен и рантайм лежат в разных файлах', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-store-'))
  const store = openStore({ dir })
  store.saveSettings({ name: 'nbw', aliases: ['ноут'], workdir: '/home/u/work' })
  store.setToken(URL_A, 'token-a')
  store.writeState(URL_A, { cursor: 7, epoch: 3, apiIds: { bash: 2 } })
  store.close()

  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(config.workdir, '/home/u/work')
  assert.equal(config.servers, undefined, 'в настройках не должно быть серверов')
  assert.equal(config.token, undefined)

  const credentials = readFileSync(join(dir, 'credentials.yaml'), 'utf8')
  assert.match(credentials, /token-a/)
  assert.ok(existsSync(join(dir, 'state.sqlite')))

  const again = openStore({ dir })
  assert.equal(again.token(URL_A), 'token-a')
  assert.equal(again.readState(URL_A).cursor, 7)
  assert.deepEqual(again.readState(URL_A).apiIds, { bash: 2 })
  again.close()
  rmSync(dir, { recursive: true, force: true })
})

test('токены разных серверов не мешают друг другу', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-store2-'))
  const store = openStore({ dir })
  store.setToken(URL_A, 'token-a')
  store.setToken(URL_B, 'token-b')
  store.writeState(URL_A, { cursor: 1 })
  store.writeState(URL_B, { cursor: 2 })
  assert.equal(store.token(URL_A), 'token-a')
  assert.equal(store.token(URL_B), 'token-b')
  assert.deepEqual(store.servers().sort(), [URL_A, URL_B].sort())
  store.forget(URL_B)
  assert.equal(store.token(URL_B), null)
  assert.deepEqual(store.servers(), [URL_A])
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('старый config.json с серверами переезжает по местам', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-store3-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    id: 'x',
    name: 'old',
    servers: { [URL_A]: { token: 'legacy-token', cursor: 4, epoch: 2, node: 9, alias: 'old-node', apiIds: { bash: 7 } } },
  }))
  const store = openStore({ dir })
  assert.equal(store.token(URL_A), 'legacy-token', 'токен переехал в credentials')
  const state = store.readState(URL_A)
  assert.equal(state.cursor, 4)
  assert.equal(state.node, 9)
  assert.deepEqual(state.apiIds, { bash: 7 })
  assert.equal(store.settings.name, 'old', 'настройки остались')
  const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
  assert.equal(config.servers, undefined, 'из настроек серверы убраны')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
