/**
 * Config: YAML is canonical, JSON is read, comments survive.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

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
  assert.equal(store.settings.policy['https://x'].max, 'rw')
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
    '# правила для сервера',
    'policy:',
    '  "https://x/dsh-nodes": {max: rw}',
    '',
  ].join('\n'))
  const store = openStore({ dir })
  store.saveSettings({ policy: { 'https://x/dsh-nodes': { max: 'full' } } })
  const text = readFileSync(file, 'utf8')
  assert.match(text, /# это мой ноутбук/)
  assert.match(text, /# правила для сервера/)
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
  assert.match(text, /policy: \{\}/, 'policy — настоящее значение, а не комментарий')
  assert.match(text, /^# (пример|example|示例):/m, 'пример policy закомментирован')
  assert.match(text, /pingInterval: 15/)
  store.saveSettings({ name: 'fresh' })
  const after = readFileSync(file, 'utf8')
  assert.match(after, /name: fresh/)
  assert.match(after, /^# (пример|example|示例):/m, 'комментарии пережили правку')
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
