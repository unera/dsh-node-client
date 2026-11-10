/**
 * Local approval: building the command and the human answer.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askLocally, buildArgs, splitArgs, usesStdin } from '../lib/approver.mjs'

test('the template is split before substitution: spaces in the text do not break the argument', () => {
  const args = buildArgs('zenity --question --text=%s', 'разрешить rm -rf?')
  assert.deepEqual(args, ['zenity', '--question', '--text=разрешить rm -rf?'])
})

test('quotes in the template are respected', () => {
  assert.deepEqual(splitArgs('a --b="c d" e'), ['a', '--b=c d', 'e'])
})

test('code 0 means "allowed", non-zero means "no"', async () => {
  assert.equal(await askLocally({ tool: 'true %s', prompt: 'x', payload: '{}' }), true)
  assert.equal(await askLocally({ tool: 'false %s', prompt: 'x', payload: '{}' }), false)
})

test('cancellation by signal stops the wait', async () => {
  const controller = new AbortController()
  const waiting = askLocally({ tool: 'sleep 5', prompt: 'x', payload: '{}', signal: controller.signal })
  controller.abort()
  await assert.rejects(() => waiting, /отменён/)
})

test('an empty command is an honest error, not silence', async () => {
  await assert.rejects(() => askLocally({ tool: '   ', prompt: 'x', payload: '{}' }), /пустая/)
})

test('without %s the text goes to stdin, not to the command line', async () => {
  const file = '/tmp/dshnc-approver-stdin.txt'
  rmSync(file, { force: true })
  const tool = `sh -c "cat > ${file}"`
  const prompt = 'длинный текст с "кавычками" и $знаками, который в аргумент не влезет'
  assert.equal(usesStdin(tool), true)
  assert.equal(await askLocally({ tool, prompt, payload: { id: 'x', mode: 'rw' } }), true)
  assert.equal(readFileSync(file, 'utf8'), prompt, 'на stdin должен прийти ровно текст вопроса')
  rmSync(file, { force: true })
})

test('structured data travels in the environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-env-'))
  const script = join(dir, 'approver.sh')
  const out = join(dir, 'seen.txt')
  writeFileSync(script, `#!/bin/sh\nprintf '%s/%s' "$DSHNC_APPROVAL_ID" "$DSHNC_APPROVAL_MODE" > ${out}\n`)
  const tool = `sh ${script}`
  await askLocally({ tool, prompt: 'x', payload: { id: 'abc', mode: 'full' } })
  assert.equal(readFileSync(out, 'utf8').trim(), 'abc/full')
  rmSync(dir, { recursive: true, force: true })
})

test('an empty command is an honest error, not silence', async () => {
  await assert.rejects(() => askLocally({ tool: '   ', prompt: 'x', payload: '{}' }), /пустая/)
})

test('without %s the text goes to stdin, not to the command line', async () => {
  const file = '/tmp/dshnc-approver-stdin.txt'
  rmSync(file, { force: true })
  const tool = `sh -c "cat > ${file}"`
  const prompt = 'длинный текст с "кавычками" и $знаками, который в аргумент не влезет'
  assert.equal(usesStdin(tool), true)
  assert.equal(await askLocally({ tool, prompt, payload: { id: 'x', mode: 'rw' } }), true)
  assert.equal(readFileSync(file, 'utf8'), prompt, 'на stdin должен прийти ровно текст вопроса')
  rmSync(file, { force: true })
})


test('the session and the question number travel in the question environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-envs-'))
  const script = join(dir, 'approver.sh')
  const out = join(dir, 'seen.txt')
  writeFileSync(script, `#!/bin/sh\nprintf '%s|%s|%s' "$DSHNC_SESSION" "$DSHNC_QUESTION" "$DSHNC_CALL" > ${out}\nexit 0\n`)
  await askLocally({
    tool: `sh ${script}`,
    prompt: 'x',
    payload: { id: 'i', mode: 'rw', session: 'session-abc', question: { rootCallId: 'call-1', callId: 'call-2' } },
  })
  assert.equal(readFileSync(out, 'utf8').trim(), 'session-abc|call-1|call-2')
  rmSync(dir, { recursive: true, force: true })
})
