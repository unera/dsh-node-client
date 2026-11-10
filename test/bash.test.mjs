/**
 * Bash executor: stdin, stdout/stderr separation, exit code, timeout.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runBash } from '../lib/bash.mjs'
import { setLang } from '../lib/i18n.mjs'

setLang('en')

test('stdout arrives as a separate block', async () => {
  const result = await runBash({ command: 'echo hello' })
  assert.equal(result.ok, true)
  assert.equal(result.results[0].text.trim(), 'hello')
})

test('stderr is marked so the model does not mix up the streams', async () => {
  const result = await runBash({ command: 'echo out; echo err >&2' })
  const texts = result.results.map((block) => block.text)
  assert.equal(texts[0].trim(), 'out')
  assert.match(texts[1], /^\[stderr\] err/)
})

test('stdin reaches the command', async () => {
  const result = await runBash({ command: 'cat', stdin: 'привет из stdin' })
  assert.equal(result.ok, true)
  assert.match(result.results[0].text, /привет из stdin/)
})

test('empty stdin closes the stream instead of hanging', async () => {
  const result = await runBash({ command: 'cat; echo done', stdin: '' })
  assert.match(result.results[0].text, /done/)
})

test('exit code is visible in the last block', async () => {
  const result = await runBash({ command: 'exit 7' })
  assert.equal(result.ok, true)
  const meta = JSON.parse(result.results.at(-1).text)
  assert.equal(meta.code, 7)
})

test('session directory is created under workdir and becomes cwd', async () => {
  const { sessionDir } = await import('../lib/bash.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work-'))
  const dir = sessionDir({ workdir: root, session: 'session-a7fd5961-4be0' })
  assert.equal(dir, join(root, 'session-a7fd5961-4be0'))
  assert.ok(existsSync(dir))
  // characters unsafe for a name are replaced
  const weird = sessionDir({ workdir: root, session: '../evil/id' })
  assert.equal(weird, join(root, '.._evil_id'))
  rmSync(root, { recursive: true, force: true })
})

test('shell plugin runs the command in the session directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work2-'))
  const { handle } = await import('../lib/plugins/shell.mjs')
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

test('dangerous session id is rejected instead of escaping workdir', async () => {
  const { sessionDir } = await import('../lib/bash.mjs')
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work3-'))
  // exactly these two mean "the directory itself" and "the parent" - they cannot become a name
  for (const bad of ['..', '.']) {
    assert.throws(() => sessionDir({ workdir: root, session: bad }), /недопустимый/)
  }
  // the rest is cleaned up to a safe name and does not leave workdir
  for (const weird of ['/', '../..', 'a/../../b']) {
    const dir = sessionDir({ workdir: root, session: weird })
    assert.ok(dir.startsWith(root + '/'), `каталог ${dir} должен лежать внутри ${root}`)
    assert.ok(!dir.includes('/../'))
  }
  rmSync(root, { recursive: true, force: true })
})

test('plugin honestly refuses when the session directory cannot be made', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-work4-'))
  const { handle } = await import('../lib/plugins/shell.mjs')
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
