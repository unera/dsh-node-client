/**
 * Config: YAML is canonical, JSON is read, comments survive.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parse as parseYaml } from 'yaml'

import { openStore } from '../lib/store.mjs'

function fresh () {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-config-'))
  return { dir, file: join(dir, 'config.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an old config.json is migrated to YAML once, and kept as .bak', () => {
  const { dir, file, cleanup } = fresh()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: 'nbw', policy: { 'https://x': { max: 'rw' } } }))
  const store = openStore({ dir })
  assert.equal(store.settings.name, 'nbw')
  // the per-server map is flattened: one address, the rules at the top level
  assert.equal(store.settings.server, 'https://x')
  assert.equal(store.settings.max, 'rw')
  assert.ok(existsSync(file), 'появился config.yaml')
  assert.match(readFileSync(file, 'utf8'), /^# /m, 'в новом файле есть объяснения')
  assert.ok(!existsSync(join(dir, 'config.json')), 'старый json убран с дороги')
  assert.ok(existsSync(join(dir, 'config.json.bak')), 'но сохранён как .bak')
  store.close?.()
  cleanup()
})

test('the empty value of a key is not lost on migration', () => {
  const { dir, file, cleanup } = fresh()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: 'nbw', workdir: null, aliases: ['a', 'b'] }))
  const store = openStore({ dir })
  assert.equal(store.settings.workdir, null)
  assert.deepEqual(store.settings.aliases, ['a', 'b'])
  const text = readFileSync(file, 'utf8')
  assert.match(text, /aliases:\n {2}- a\n {2}- b/, 'список остался списком')
  store.close?.()
  cleanup()
})

test('YAML with comments: an edit keeps the comments', () => {
  const { dir, file, cleanup } = fresh()
  writeFileSync(file, [
    '# это мой ноутбук',
    'name: nbw',
    'server: https://x/dsh-nodes',
    '# потолок прав',
    'max: rw',
    '',
  ].join('\n'))
  const store = openStore({ dir })
  store.saveSettings({ max: 'full' })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# это мой ноутбук/)
  assert.match(text, /# потолок прав/)
  assert.match(text, /max: full/)
  store.close?.()
  cleanup()
})

test('broken YAML does not turn into default settings', () => {
  const { dir, file, cleanup } = fresh()
  writeFileSync(file, 'name: [не закрыт\n')
  assert.throws(() => openStore({ dir }), /не смог разобрать|ошибка YAML/)
  cleanup()
})

test('without a config the client writes a commented template', () => {
  const { dir, file, cleanup } = fresh()
  const store = openStore({ dir })
  // a fresh node names itself after the host: an unnamed node is hard to tell apart
  assert.ok(store.settings.name, 'имя по умолчанию задано')
  assert.ok(store.settings.id, 'id клиента задан')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^# .*config\.yaml/m, 'шапка с объяснением')
  assert.match(text, /^server: null$/m, 'сервер — настоящее значение, а не комментарий')
  assert.match(text, /^max: rw$/m)
  assert.match(text, /^approver: none$/m)
  assert.match(text, /pingInterval: 15/)
  store.saveSettings({ name: 'fresh' })
  const after = readFileSync(file, 'utf8')
  assert.match(after, /name: fresh/)
  assert.match(after, /^# /m, 'комментарии пережили правку')
  store.close?.()
  cleanup()
})

test('top-level settings are changed by a command, not by editing the file', async () => {
  const { execFileSync } = await import('node:child_process')
  const { dir, cleanup } = fresh()
  writeFileSync(join(dir, 'config.yaml'), '# мой комментарий\nname: nbw\npingInterval: 30\n')
  execFileSync(process.execPath, ['bin/dshnc.mjs', 'config', 'pingInterval=0'], {
    env: { ...process.env, DSHNC_HOME: dir },
    cwd: new URL('..', import.meta.url).pathname,
  })
  const text = readFileSync(join(dir, 'config.yaml'), 'utf8')
  assert.match(text, /# мой комментарий/, 'комментарии не должны пострадать')
  assert.match(text, /pingInterval: 0/)
  cleanup()
})

test('-c points the client at another config, the state stays shared', async () => {
  const { execFileSync } = await import('node:child_process')
  const { dir, cleanup } = fresh()
  const other = join(dir, 'second.yaml')
  writeFileSync(other, 'server: https://second/dsh-nodes\nname: second\n')
  const run = (args) => execFileSync(process.execPath, ['bin/dshnc.mjs', ...args], {
    env: { ...process.env, DSHNC_HOME: dir, DSHNC_LANG: 'ru' },
    cwd: new URL('..', import.meta.url).pathname,
    encoding: 'utf8',
  })
  const text = run(['-c', other, 'status'])
  assert.match(text, /second/, 'взят конфиг из -c')
  assert.match(text, new RegExp(`конфиг: ${other}`))
  // a hand-written config gets an identity, otherwise the node cannot be paired
  const written = parseYaml(readFileSync(other, 'utf8'))
  assert.ok(written.id, 'id появился')
  assert.equal(written.server, 'https://second/dsh-nodes')
  // the default config was not touched and the token file is common
  assert.ok(!existsSync(join(dir, 'config.yaml')), 'чужой конфиг не создаётся')
  cleanup()
})

test('a token entered by hand lands in the shared credentials, the address in the config', async () => {
  const { connectTo } = await import('../lib/connect.mjs')
  const { dir, file, cleanup } = fresh()
  const address = await connectTo({
    target: { server: 'https://x.uvw.ru/dsh-nodes/', token: 'tok-abc' },
    config: { name: 'mx' },
    store: () => openStore({ dir }),
  })
  assert.equal(address, 'https://x.uvw.ru/dsh-nodes', 'адрес нормализован')
  const settings = parseYaml(readFileSync(file, 'utf8'))
  assert.equal(settings.server, 'https://x.uvw.ru/dsh-nodes')
  const credentials = readFileSync(join(dir, 'credentials.yaml'), 'utf8')
  assert.match(credentials, /tok-abc/)
  // the token is readable by the store under its own address
  assert.equal(openStore({ dir }).token('https://x.uvw.ru/dsh-nodes'), 'tok-abc')
  cleanup()
})
