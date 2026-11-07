/**
 * Конфиг: YAML канонический, JSON читается, комментарии живут.
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

test('старый config.json читается без миграции', () => {
  const { dir, cleanup } = fresh()
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ name: 'nbw', policy: { 'https://x': { max: 'rw' } } }))
  const store = openStore({ dir })
  assert.equal(store.settings.name, 'nbw')
  assert.equal(store.settings.policy['https://x'].max, 'rw')
  store.close?.()
  cleanup()
})

test('YAML с комментариями: правка сохраняет комментарии', () => {
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

test('битый YAML не превращается в настройки по умолчанию', () => {
  const { dir, file, cleanup } = fresh()
  writeFileSync(file, 'name: [не закрыт\n')
  assert.throws(() => openStore({ dir }), /не смог разобрать|ошибка YAML/)
  cleanup()
})

test('без конфига клиент стартует с умолчаниями и создаёт YAML', () => {
  const { dir, file, cleanup } = fresh()
  const store = openStore({ dir })
  assert.equal(store.settings.name, null)
  store.saveSettings({ name: 'fresh' })
  assert.match(readFileSync(file, 'utf8'), /name: fresh/)
  store.close?.()
  cleanup()
})
