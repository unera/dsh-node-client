/**
 * Sandbox: bwrap profiles, denial classification, modes and session directories.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { classify, narrower, profileArgs, probe, WIDER_MODES } from '../lib/sandbox.mjs'
import { assertInside, canonicalPath, createSessionStore, inside, prepareSessionDir } from '../lib/sessions.mjs'
import { runBash } from '../lib/bash.mjs'
import { openStore } from '../lib/store.mjs'
import { policyFor, sandboxFor } from '../lib/runner.mjs'

test('the mode narrows to the ceiling but never widens', () => {
  assert.equal(narrower('full', 'ro'), 'ro')
  assert.equal(narrower('ro', 'full'), 'ro')
  assert.equal(narrower('rw', 'rw'), 'rw')
  assert.deepEqual(WIDER_MODES.ro, ['rw', 'full'])
  assert.deepEqual(WIDER_MODES.full, [])
})

test('the ro profile has no write bind, the rw one does', () => {
  const ro = profileArgs({ mode: 'ro', cwd: '/tmp' })
  assert.ok(ro.includes('--ro-bind'))
  assert.ok(!ro.includes('--bind'), 'в ro не должно быть записи')
  assert.ok(ro.includes('--unshare-net'), 'сеть в ro отрезана')
  const rw = profileArgs({ mode: 'rw', workdir: '/home/u/work', cwd: '/home/u/work/s1' })
  assert.ok(rw.includes('--bind'))
  assert.ok(rw.includes('/home/u/work'))
  assert.ok(rw.includes('--chdir'))
  assert.deepEqual(profileArgs({ mode: 'full' }), [], 'full не оборачивается')
})

test('a denial is recognised by its signature, the exit code is secondary', () => {
  assert.equal(classify({ code: 1, stderr: 'cannot touch: Read-only file system', mode: 'ro' }).denied, true)
  // a compound command can return 0 even though the write was already rejected by the kernel
  assert.equal(classify({ code: 0, stderr: 'bash: /x: Read-only file system', mode: 'ro' }).denied, true)
  assert.equal(classify({ code: 1, stderr: 'bwrap: No permissions to creating new namespace', mode: 'ro' }).runnerFailure, true)
  assert.equal(classify({ code: 1, stderr: 'command not found', mode: 'ro' }).denied, false)
  assert.equal(classify({ code: 1, stderr: 'Read-only file system', mode: 'full' }).denied, false)
})

test('bwrap works on this machine', process.env.CI ? { skip: 'в раннере GitHub нет прав на user namespaces' } : {}, () => {
  const result = probe()
  assert.equal(result.available, true, `bwrap не работает: ${result.reason ?? ''}`)
})

test('the sandbox really forbids writing outside workdir', process.env.CI ? { skip: 'нужен bwrap' } : {}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-sb-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  // deliberately not in /tmp: it has its own tmpfs inside the sandbox, so the write would be allowed
  const outsideDir = mkdtempSync('/var/tmp/dshnc-outside-')
  const outside = join(outsideDir, 'outside.txt')
  writeFileSync(outside, 'x')

  const sandbox = {
    mode: 'rw',
    args: profileArgs({ mode: 'rw', workdir: work, cwd: work }),
    probe,
    classify,
  }
  const inside = await runBash({ command: 'echo ok > inside.txt && cat inside.txt', cwd: work, sandbox })
  assert.match(inside.results[0].text, /ok/)

  // compound command: exit code 0, but the write was rejected - the denial must still be visible
  const denied = await runBash({ command: `echo hack > ${outside}; echo код $?`, cwd: work, sandbox })
  const report = JSON.parse(denied.results.at(-1).text)
  assert.equal(report.sandbox.mode, 'rw')
  assert.equal(report.sandbox.denied, true, 'запись вне workdir должна быть отказом')
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

test('session directory: allowed inside roots, no outside them', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-roots-'))
  const work = join(root, 'work')
  mkdirSync(join(work), { recursive: true })
  const prepared = prepareSessionDir({ workdir: work, session: 'session-1', roots: [work] })
  assert.equal(prepared.dir, join(work, 'session-1'))
  assert.throws(() => assertInside('/etc', [work]), /вне разрешённых/)
  assert.equal(inside(canonicalPath(join(work, 'session-1')), work), true)
  assert.equal(inside('/etc/passwd', work), false)
  rmSync(root, { recursive: true, force: true })
})

test('session.chdir does not create the directory, mkdir does', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-mk-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  const store = openStore({ dir: join(root, 'state') })
  const sessions = createSessionStore(store)

  // chdir into a missing one is an error, not a silent creation
  assert.throws(() => sessions.chdir('s1', join(root, 'нет-такого'), { roots: [root] }), /нет/)
  // mkdir creates it, and after that chdir works
  const made = sessions.mkdir('s1', join(root, 'проект'), { roots: [root], mode: 0o700 })
  assert.equal(made.created, true)
  const again = sessions.mkdir('s1', join(root, 'проект'), { roots: [root] })
  assert.equal(again.created, false, 'повторный mkdir не падает')
  sessions.chdir('s1', join(root, 'проект'), { roots: [root] })
  assert.equal(sessions.cwd('s1', { workdir: work, roots: [root] }), join(root, 'проект'))
  // mkdir is not allowed outside the roots
  assert.throws(() => sessions.mkdir('s1', '/etc/нельзя', { roots: [root] }), /вне разрешённых/)
  rmSync(root, { recursive: true, force: true })
})

test('session.chdir switches the directory and remembers it', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-chdir-'))
  const work = join(root, 'work')
  const other = join(root, 'foobar')
  mkdirSync(work, { recursive: true })
  const store = openStore({ dir: join(root, 'state') })
  const sessions = createSessionStore(store)

  assert.equal(sessions.cwd('s1', { workdir: work, roots: [root] }), join(work, 's1'))
  sessions.mkdir('s1', other, { roots: [root] })
  const changed = sessions.chdir('s1', other, { roots: [root] })
  assert.equal(changed.dir, other)
  assert.equal(sessions.cwd('s1', { workdir: work, roots: [root] }), other, 'выбор должен сохраниться')
  assert.throws(() => sessions.chdir('s1', '/etc', { roots: [root] }), /вне разрешённых/)
  rmSync(root, { recursive: true, force: true })
})

test('the ceiling of the node does not allow widening the mode', () => {
  const config = { workdir: '/home/u/work', max: 'full', ask: false }
  assert.equal(policyFor(config).max, 'full')
  assert.equal(policyFor(config).ask, false)
  // the server asks for full, the node ceiling is ro
  const narrow = { ...config, max: 'ro' }
  assert.equal(policyFor({ max: 'ro' }).max, 'ro', 'потолок берётся из конфига')
  const sandbox = sandboxFor(narrow, { sandbox: { mode: 'full' }, session: null }, null)
  assert.equal(sandbox.mode, 'ro')
})

test('base lowers an ordinary command but not a confirmed one', () => {
  const config = { base: 'rw', max: 'full', approver: 'local' }
  assert.equal(sandboxFor(config, { sandbox: { mode: 'full' } }, null).mode, 'rw', 'обычная — по base')
  assert.equal(
    sandboxFor(config, { sandbox: { mode: 'full' }, approved: 'id-1' }, null).mode,
    'full',
    'подтверждённую понижать нельзя',
  )
  // with approver: none base is not applied at all
  const none = { base: 'ro', max: 'full', approver: 'none' }
  assert.equal(sandboxFor(none, { sandbox: { mode: 'full' } }, null).mode, 'full')
  // a request already at base stays as it is
  assert.equal(sandboxFor(config, { sandbox: { mode: 'ro' } }, null).mode, 'ro')
})

test('the node ceiling cuts even a confirmed command', () => {
  const config = { base: 'rw', max: 'rw', approver: 'local' }
  assert.equal(sandboxFor(config, { sandbox: { mode: 'full' }, approved: 'id' }, null).mode, 'rw')
})

test('"Permission denied" outside the allowed directories is a sandbox denial', () => {
  const verdict = classify({
    code: 1,
    stderr: "touch: cannot touch '/root/abc.txt': Permission denied",
    mode: 'rw',
    enforcement: 'bwrap',
  })
  assert.equal(verdict.denied, true, 'иначе человеку не задаётся вопрос о расширении')
  assert.equal(verdict.signature, 'permission denied')
})

test('in full mode it does not count as a denial: there is no sandbox there', () => {
  const verdict = classify({ code: 1, stderr: 'Permission denied', mode: 'full' })
  assert.equal(verdict.denied, false)
})
