/**
 * Файловый API: пути, версии, атомарность, коды ошибок.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import * as files from '../lib/plugins/files.mjs'

const payload = (answer) => JSON.parse(answer.results[0].text)

function sandbox () {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-files-'))
  return { root, ctx: { roots: [root] }, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('read отдаёт текст и версию, лишнее за пределами limit помечает truncated', async () => {
  const { root, ctx, cleanup } = sandbox()
  writeFileSync(join(root, 'a.txt'), 'привет мир')
  const all = payload(await files.handle({ method: 'read', args: { path: join(root, 'a.txt') } }, ctx))
  assert.equal(all.text, 'привет мир')
  assert.match(all.version, /^\d+-\d+$/)

  const part = payload(await files.handle({ method: 'read', args: { path: join(root, 'a.txt'), limit: 3 } }, ctx))
  assert.equal(part.truncated, true)
  cleanup()
})

test('write создаёт каталоги и возвращает новую версию', async () => {
  const { root, ctx, cleanup } = sandbox()
  const target = join(root, 'sub/dir/b.txt')
  const answer = payload(await files.handle({ method: 'write', args: { path: target, content: 'ok' } }, ctx))
  assert.equal(readFileSync(target, 'utf8'), 'ok')
  assert.ok(answer.version)
  cleanup()
})

test('write с ifVersion отказывает, если файл изменился', async () => {
  const { root, ctx, cleanup } = sandbox()
  const target = join(root, 'c.txt')
  writeFileSync(target, 'первая')
  const first = payload(await files.handle({ method: 'read', args: { path: target } }, ctx))
  writeFileSync(target, 'вторая версия')
  const answer = await files.handle({ method: 'write', args: { path: target, content: 'третья', ifVersion: first.version } }, ctx)
  assert.equal(answer.code, 'stale')
  assert.equal(readFileSync(target, 'utf8'), 'вторая версия', 'файл не должен быть затёрт')
  cleanup()
})

test('edit: не найдено, неоднозначно, replaceAll', async () => {
  const { root, ctx, cleanup } = sandbox()
  const target = join(root, 'd.txt')
  writeFileSync(target, 'кот и кот')
  assert.equal((await files.handle({ method: 'edit', args: { path: target, old: 'пёс', new: 'x' } }, ctx)).code, 'not_found')
  assert.equal((await files.handle({ method: 'edit', args: { path: target, old: 'кот', new: 'x' } }, ctx)).code, 'ambiguous_edit')
  const done = payload(await files.handle({ method: 'edit', args: { path: target, old: 'кот', new: 'x', replaceAll: true } }, ctx))
  assert.equal(done.replaced, 2)
  assert.equal(readFileSync(target, 'utf8'), 'x и x')
  cleanup()
})

test('путь вне roots отвергается до обращения к диску', async () => {
  const { ctx, cleanup } = sandbox()
  const answer = await files.handle({ method: 'read', args: { path: '/etc/hostname' } }, ctx)
  assert.equal(answer.code, 'path_denied')
  cleanup()
})

test('list и stat', async () => {
  const { root, ctx, cleanup } = sandbox()
  writeFileSync(join(root, 'e.txt'), 'x')
  const listed = payload(await files.handle({ method: 'list', args: { path: root } }, ctx))
  assert.ok(listed.entries.some((entry) => entry.name === 'e.txt' && entry.type === 'file'))
  const missing = payload(await files.handle({ method: 'stat', args: { path: join(root, 'нет.txt') } }, ctx))
  assert.equal(missing.exists, false)
  cleanup()
})
