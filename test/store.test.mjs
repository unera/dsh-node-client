/**
 * Client store: settings, tokens and runtime live in different places.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'

import { openStore } from '../lib/store.mjs'

const URL_A = 'https://dsh.uvw.ru/dsh-nodes'
const URL_B = 'http://127.0.0.1:3080/dsh-nodes'

test('settings, token and runtime live in different files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-store-'))
  const store = openStore({ dir })
  store.saveSettings({ name: 'nbw', aliases: ['ноут'], workdir: '/home/u/work' })
  store.setToken(URL_A, 'token-a')
  store.writeState(URL_A, { epoch: 3, apiIds: { bash: 2 } })
  store.close()

  const config = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf8'))
  assert.equal(config.workdir, '/home/u/work')
  assert.equal(config.servers, undefined, 'в настройках не должно быть серверов')
  assert.equal(config.token, undefined)

  const credentials = readFileSync(join(dir, 'credentials.yaml'), 'utf8')
  assert.match(credentials, /token-a/)
  assert.ok(existsSync(join(dir, 'state.sqlite')))

  const again = openStore({ dir })
  assert.equal(again.token(URL_A), 'token-a')
  assert.equal(again.readState(URL_A).epoch, 3)
  assert.deepEqual(again.readState(URL_A).apiIds, { bash: 2 })
  again.close()
  rmSync(dir, { recursive: true, force: true })
})

test('one token file serves several configs: addresses do not overwrite each other', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-store2-'))
  const store = openStore({ dir })
  store.setToken(URL_A, 'token-a')
  store.setToken(URL_B, 'token-b')
  store.writeState(URL_A, { epoch: 1 })
  store.writeState(URL_B, { epoch: 2 })
  assert.equal(store.token(URL_A), 'token-a')
  assert.equal(store.token(URL_B), 'token-b')
  assert.deepEqual(store.knownServers().sort(), [URL_A, URL_B].sort())
  store.forget(URL_B)
  assert.equal(store.token(URL_B), null)
  assert.deepEqual(store.knownServers(), [URL_A])
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('an old config.json with servers migrates into its places', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-store3-'))
  writeFileSync(join(dir, 'config.yaml'), JSON.stringify({
    id: 'x',
    name: 'old',
    servers: { [URL_A]: { token: 'legacy-token', epoch: 2, node: 9, alias: 'old-node', apiIds: { bash: 7 } } },
  }))
  const store = openStore({ dir })
  assert.equal(store.token(URL_A), 'legacy-token', 'токен переехал в credentials')
  const state = store.readState(URL_A)
  assert.equal(state.epoch, 2)
  assert.equal(state.node, 9)
  assert.deepEqual(state.apiIds, { bash: 7 })
  assert.equal(store.settings.name, 'old', 'настройки остались')
  const config = parseYaml(readFileSync(join(dir, 'config.yaml'), 'utf8'))
  assert.equal(config.servers, undefined, 'из настроек серверы убраны')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('applied migrations are recorded in the DB and are not repeated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-migr-'))
  const first = openStore({ dir })
  const db1 = new (await import('node:sqlite')).DatabaseSync(join(dir, 'state.sqlite'))
  const applied = db1.prepare('SELECT id FROM migrations ORDER BY id').all().map((row) => row.id)
  db1.close()
  assert.deepEqual(applied, ['0001_init', '0002_split_config', '0003_session_workdir', '0004_audit'])
  first.close()

  // the second run: no new steps, nothing was applied twice
  const second = openStore({ dir })
  second.close()
  const db2 = new (await import('node:sqlite')).DatabaseSync(join(dir, 'state.sqlite'))
  const again = db2.prepare('SELECT COUNT(*) AS n FROM migrations').get().n
  db2.close()
  assert.equal(again, 4, 'уже исполненные шаги не должны дублироваться')
  rmSync(dir, { recursive: true, force: true })
})

test('credentials.yaml keeps the list of servers, and the old format is still read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-cred2-'))
  const store = openStore({ dir })
  store.setToken(URL_A, 'token-a')
  store.setToken(URL_B, 'token-b')
  store.close()

  const text = readFileSync(join(dir, 'credentials.yaml'), 'utf8')
  assert.match(text, /^servers:/m, 'должен быть список серверов')
  assert.match(text, /- url: https:\/\/dsh\.uvw\.ru\/dsh-nodes/m)

  // the old format: a url -> token map
  writeFileSync(join(dir, 'credentials.yaml'), `${URL_A}: old-token\n`)
  const old = openStore({ dir })
  assert.equal(old.token(URL_A), 'old-token', 'старый формат должен читаться')
  old.close()
  rmSync(dir, { recursive: true, force: true })
})

test('the audit keeps commands without the sandbox and survives reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-audit-'))
  const store = openStore({ dir })
  store.writeAudit({ session: 'session-1', mode: 'full', command: 'touch /etc/x', code: 1 })
  store.writeAudit({ session: 'session-2', mode: 'full', command: 'rm -rf /tmp/y', code: 0 })
  store.close()

  const again = openStore({ dir })
  const rows = again.readAudit(10)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].command, 'rm -rf /tmp/y', 'свежие записи первыми')
  assert.equal(rows[0].code, 0)
  again.close()
  rmSync(dir, { recursive: true, force: true })
})

test('the audit does not swell from long commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-audit2-'))
  const store = openStore({ dir })
  store.writeAudit({ session: 's', mode: 'full', command: 'x'.repeat(10000), code: 0 })
  const row = store.readAudit(1)[0]
  assert.ok(row.command.length <= 4000, `обрезка не сработала: ${row.command.length}`)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})
