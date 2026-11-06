/**
 * Автозапуск: текст systemd-юнита и диалог мастера.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  applyAutostartAnswers,
  canCreateUsers,
  createUserCommand,
  renderUnit,
  runAutostart,
  stateDirFor,
  unitPath,
} from '../lib/autostart.mjs'
import { setLang } from '../lib/i18n.mjs'

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'dshnc-auto-'))
  setLang('en')
})
after(() => rmSync(dir, { recursive: true, force: true }))

test('user-юнит без графики — обычный default.target', () => {
  const text = renderUnit({ scope: 'user', execStart: '/usr/bin/dshnc' })
  assert.match(text, /ExecStart=\/usr\/bin\/dshnc daemon/)
  assert.match(text, /WantedBy=default\.target/)
  assert.doesNotMatch(text, /graphical-session/)
  assert.doesNotMatch(text, /User=/)
  assert.match(text, /Restart=always/)
  assert.match(text, /Environment=DSHNC_SHELL=\/bin\/bash/)
})

test('user-юнит внутри графической сессии импортирует окружение', () => {
  const text = renderUnit({ scope: 'user', execStart: '/usr/bin/dshnc', graphical: true })
  assert.match(text, /After=graphical-session\.target/)
  assert.match(text, /WantedBy=graphical-session\.target/)
  assert.match(text, /ExecStartPre=-systemctl --user import-environment DISPLAY XAUTHORITY/)
})

test('системный юнит несёт User= и HOME=', () => {
  const text = renderUnit({ scope: 'system', execStart: '/usr/bin/dshnc', user: 'dshnc', home: '/home/dshnc' })
  assert.match(text, /User=dshnc/)
  assert.match(text, /Environment=HOME=\/home\/dshnc/)
  assert.match(text, /WantedBy=default\.target/)
})

test('путь юнита зависит от области', () => {
  assert.match(unitPath('user', 'dshnc', '/tmp/x'), /^\/tmp\/x\/dshnc\.service$/)
  assert.match(unitPath('system', 'dshnc', '/tmp/x'), /^\/tmp\/x\/dshnc\.service$/)
})

test('права на создание пользователей', () => {
  assert.equal(canCreateUsers({ uid: 0 }), true)
  assert.equal(canCreateUsers({ uid: 1000, hasSudo: true }), true)
  assert.equal(canCreateUsers({ uid: 1000, hasSudo: false }), false)
  assert.match(createUserCommand('dshnc'), /^sudo useradd .*dshnc$/)
})

test('мастер: user-область, ответы ложатся в юнит', async () => {
  const answers = ['nbw', 'nbw, ноутбук', 'user', 'n']
  const lines = []
  const result = await runAutostart({
    ask: async () => answers.shift() ?? '',
    print: (line) => lines.push(line),
    config: { name: 'host', aliases: [] },
    execStart: '/usr/bin/dshnc',
    unitFile: (scope, name) => join(dir, `${scope}-${name}.service`),
  })
  assert.equal(result.scope, 'user')
  assert.equal(result.name, 'nbw')
  assert.deepEqual(result.aliases, ['nbw', 'ноутбук'])
  assert.equal(result.graphical, false)
  const text = readFileSync(result.path, 'utf8')
  assert.match(text, /WantedBy=default\.target/)
  assert.ok(lines.some((line) => /systemctl --user enable/.test(line)))
})

test('мастер: системная область с отдельным пользователем', async () => {
  const answers = ['lamp', '', 'system', 'y', 'dshnc']
  const lines = []
  const result = await runAutostart({
    ask: async () => answers.shift() ?? '',
    print: (line) => lines.push(line),
    config: { name: 'host', aliases: [], servers: {} },
    execStart: '/usr/bin/dshnc',
    unitFile: (scope, name) => join(dir, `sys-${name}.service`),
    hasSudo: true,
  })
  assert.equal(result.scope, 'system')
  assert.equal(result.user, 'dshnc')
  const text = readFileSync(result.path, 'utf8')
  assert.match(text, /User=dshnc/)
  assert.ok(lines.some((line) => /sudo systemctl enable/.test(line)))
  assert.equal(result.stateDir, '/home/dshnc/.dshnc')
})

test('ответы мастера применяются к конфигу', () => {
  const config = { name: 'host' }
  applyAutostartAnswers(config, { name: 'nbw', aliases: ['nbw', 'laptop'] })
  assert.equal(config.name, 'nbw')
  assert.deepEqual(config.aliases, ['nbw', 'laptop'])
})

test('каталог состояния зависит от области', () => {
  assert.match(stateDirFor({ scope: 'system', user: 'dshnc', home: '/home/dshnc' }), /^\/home\/dshnc\/\.dshnc$/)
  assert.match(stateDirFor({ scope: 'user' }), /\.dshnc$/)
})

test('ExecStart для .mjs несёт интерпретатор', async () => {
  const { resolveExecStart } = await import('../lib/autostart.mjs')
  assert.equal(resolveExecStart('/usr/local/bin/dshnc', '/usr/bin/node'), '/usr/local/bin/dshnc')
  assert.equal(
    resolveExecStart('/opt/dshnc/bin/dshnc.mjs', '/usr/bin/node'),
    '/usr/bin/node /opt/dshnc/bin/dshnc.mjs',
  )
})
