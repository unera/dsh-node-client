/**
 * Исполнитель bash: stdin, разделение stdout/stderr, код возврата, таймаут.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBash } from '../lib/bash.mjs'
import { setLang } from '../lib/i18n.mjs'

setLang('en')

test('stdout приходит отдельным блоком', async () => {
  const result = await runBash({ command: 'echo hello' })
  assert.equal(result.ok, true)
  assert.equal(result.results[0].text.trim(), 'hello')
})

test('stderr помечен, чтобы модель не путала потоки', async () => {
  const result = await runBash({ command: 'echo out; echo err >&2' })
  const texts = result.results.map((block) => block.text)
  assert.equal(texts[0].trim(), 'out')
  assert.match(texts[1], /^\[stderr\] err/)
})

test('stdin доезжает до команды', async () => {
  const result = await runBash({ command: 'cat', stdin: 'привет из stdin' })
  assert.equal(result.ok, true)
  assert.match(result.results[0].text, /привет из stdin/)
})

test('пустой stdin закрывает поток, а не висит', async () => {
  const result = await runBash({ command: 'cat; echo done', stdin: '' })
  assert.match(result.results[0].text, /done/)
})

test('код возврата виден в последнем блоке', async () => {
  const result = await runBash({ command: 'exit 7' })
  assert.equal(result.ok, true)
  const meta = JSON.parse(result.results.at(-1).text)
  assert.equal(meta.code, 7)
})

test('каталог сессии создаётся под workdir и становится cwd', async () => {
  const { sessionDir } = await import('../lib/bash.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work-'))
  const dir = sessionDir({ workdir: root, session: 'session-a7fd5961-4be0' })
  assert.equal(dir, join(root, 'session-a7fd5961-4be0'))
  assert.ok(existsSync(dir))
  // опасные для имени символы заменяются
  const weird = sessionDir({ workdir: root, session: '../evil/id' })
  assert.equal(weird, join(root, '.._evil_id'))
  rmSync(root, { recursive: true, force: true })
})

test('плагин bash запускает команду в каталоге сессии', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work2-'))
  const { handle } = await import('../lib/plugins/bash.mjs')
  const { createSessionStore } = await import('../lib/sessions.mjs')
  const { openStore } = await import('../lib/store.mjs')
  const sessions = createSessionStore(openStore({ dir: root }))
  const outcome = await handle(
    { method: 'exec', args: { command: 'pwd' } },
    { workdir: join(root, 'work'), session: 'sess-42', sessions, roots: [root] },
  )
  assert.match(outcome.results[0].text, /sess-42/)
  rmSync(root, { recursive: true, force: true })
})

test('опасный идентификатор сессии отвергается, а не выводит за workdir', async () => {
  const { sessionDir } = await import('../lib/bash.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work3-'))
  // ровно эти два означают «сам каталог» и «родитель» — их не превратить в имя
  for (const bad of ['..', '.']) {
    assert.throws(() => sessionDir({ workdir: root, session: bad }), /недопустимый/)
  }
  // остальное чистится до безопасного имени и не выходит за workdir
  for (const weird of ['/', '../..', 'a/../../b']) {
    const dir = sessionDir({ workdir: root, session: weird })
    assert.ok(dir.startsWith(root + '/'), `каталог ${dir} должен лежать внутри ${root}`)
    assert.ok(!dir.includes('/../'))
  }
  rmSync(root, { recursive: true, force: true })
})

test('плагин честно отказывает, если каталог сессии не сделать', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work4-'))
  const { handle } = await import('../lib/plugins/bash.mjs')
  const { createSessionStore } = await import('../lib/sessions.mjs')
  const { openStore } = await import('../lib/store.mjs')
  const sessions = createSessionStore(openStore({ dir: join(root, 'state') }))
  const outcome = await handle(
    { method: 'exec', args: { command: 'pwd' } },
    { workdir: join(root, 'work'), session: '..', sessions, roots: [root] },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'bad_session')
  rmSync(root, { recursive: true, force: true })
})
