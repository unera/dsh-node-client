/**
 * Config: YAML is canonical, JSON is read, comments survive.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openStore } from '../lib/store.mjs'

function fresh () {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-config-'))
  return { dir, file: join(dir, 'config.yaml'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('an old config.json is read without migration', () => {
  const { dir, cleanup } = fresh()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: 'nbw', policy: { 'https://x': { max: 'rw' } } }))
  const store = openStore({ dir })
  assert.equal(store.settings.name, 'nbw')
  assert.equal(store.settings.policy['https://x'].max, 'rw')
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

test('without a config the client starts with defaults and creates YAML', () => {
  const { dir, file, cleanup } = fresh()
  const store = openStore({ dir })
  assert.equal(store.settings.name, null)
  store.saveSettings({ name: 'fresh' })
  assert.match(readFileSync(file, 'utf8'), /name: fresh/)
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
