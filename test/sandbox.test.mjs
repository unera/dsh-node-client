/**
 * Песочница: профили bwrap, классификация отказа, режимы и каталоги сессий.
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

test('режим сужается до потолка, но не расширяется', () => {
  assert.equal(narrower('full', 'ro'), 'ro')
  assert.equal(narrower('ro', 'full'), 'ro')
  assert.equal(narrower('rw', 'rw'), 'rw')
  assert.deepEqual(WIDER_MODES.ro, ['rw', 'full'])
  assert.deepEqual(WIDER_MODES.full, [])
})

test('в ro-профиле нет привязки на запись, в rw есть', () => {
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

test('отказ распознаётся только при ненулевом коде и сигнатуре', () => {
  assert.equal(classify({ code: 1, stderr: 'cannot touch: Read-only file system', mode: 'ro' }).denied, true)
  assert.equal(classify({ code: 0, stderr: 'Read-only file system', mode: 'ro' }).denied, false, 'код 0 — не отказ')
  assert.equal(classify({ code: 1, stderr: 'bwrap: No permissions to creating new namespace', mode: 'ro' }).runnerFailure, true)
  assert.equal(classify({ code: 1, stderr: 'command not found', mode: 'ro' }).denied, false)
  assert.equal(classify({ code: 1, stderr: 'Read-only file system', mode: 'full' }).denied, false)
})

test('bwrap на этой машине работает', () => {
  const result = probe()
  assert.equal(result.available, true, `bwrap не работает: ${result.reason ?? ''}`)
})

test('песочница реально не даёт писать вне workdir', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-sb-'))
  const work = join(root, 'work')
  mkdirSync(work, { recursive: true })
  // специально не в /tmp: там в песочнице свой tmpfs, и запись была бы разрешена
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

  const denied = await runBash({ command: `echo hack > ${outside}`, cwd: work, sandbox })
  const report = JSON.parse(denied.results.at(-1).text)
  assert.equal(report.sandbox.mode, 'rw')
  assert.equal(report.sandbox.denied, true, 'запись вне workdir должна быть отказом')
  rmSync(root, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

test('каталог сессии: внутри roots можно, вне — no', () => {
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

test('session.chdir переключает каталог и запоминает его', () => {
  const root = mkdtempSync(join(tmpdir(), 'dshnc-chdir-'))
  const work = join(root, 'work')
  const other = join(root, 'foobar')
  mkdirSync(work, { recursive: true })
  const store = openStore({ dir: join(root, 'state') })
  const sessions = createSessionStore(store)

  assert.equal(sessions.cwd('s1', { workdir: work, roots: [root] }), join(work, 's1'))
  const changed = sessions.chdir('s1', other, { roots: [root] })
  assert.equal(changed.dir, other)
  assert.equal(sessions.cwd('s1', { workdir: work, roots: [root] }), other, 'выбор должен сохраниться')
  assert.throws(() => sessions.chdir('s1', '/etc', { roots: [root] }), /вне разрешённых/)
  rmSync(root, { recursive: true, force: true })
})

test('правила на сервер перекрывают общие, потолок не даёт расширить режим', () => {
  const config = {
    workdir: '/home/u/work',
    access: { max: 'ro', ask: true },
    policy: { 'https://a/dsh-nodes': { max: 'full', ask: false } },
  }
  assert.equal(policyFor(config, 'https://a/dsh-nodes').max, 'full')
  assert.equal(policyFor(config, 'https://a/dsh-nodes').ask, false)
  assert.equal(policyFor(config, 'https://b/dsh-nodes').max, 'ro', 'для другого сервера — общий потолок')
  // сервер просит full, у узла потолок ro
  const sandbox = sandboxFor(config, { sandbox: { mode: 'full' }, session: null }, null, 'https://b/dsh-nodes')
  assert.equal(sandbox.mode, 'ro')
})
