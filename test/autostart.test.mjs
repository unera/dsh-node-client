/**
 * Autostart: the text of the systemd unit and the wizard dialogue.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('user unit without graphics - a plain default.target', () => {
  const text = renderUnit({ scope: 'user', execStart: '/usr/bin/dshnc' })
  assert.match(text, /ExecStart=\/usr\/bin\/dshnc daemon/)
  assert.match(text, /WantedBy=default\.target/)
  assert.doesNotMatch(text, /graphical-session/)
  assert.doesNotMatch(text, /User=/)
  assert.match(text, /Restart=always/)
  assert.match(text, /Environment=DSHNC_SHELL=\/bin\/bash/)
})

test('user unit inside a graphical session imports the environment', () => {
  const text = renderUnit({ scope: 'user', execStart: '/usr/bin/dshnc', graphical: true })
  assert.match(text, /After=graphical-session\.target/)
  assert.match(text, /WantedBy=graphical-session\.target/)
  assert.match(text, /ExecStartPre=-\/bin\/sh -c 'systemctl --user import-environment DISPLAY XAUTHORITY/)
})

test('system unit carries User= and HOME=', () => {
  const text = renderUnit({ scope: 'system', execStart: '/usr/bin/dshnc', user: 'dshnc', home: '/home/dshnc' })
  assert.match(text, /User=dshnc/)
  assert.match(text, /Environment=HOME=\/home\/dshnc/)
  assert.match(text, /WantedBy=default\.target/)
})

test('the unit path depends on the scope', () => {
  assert.match(unitPath('user', 'dshnc', '/tmp/x'), /^\/tmp\/x\/dshnc\.service$/)
  assert.match(unitPath('system', 'dshnc', '/tmp/x'), /^\/tmp\/x\/dshnc\.service$/)
})

test('rights to create users', () => {
  assert.equal(canCreateUsers({ uid: 0 }), true)
  assert.equal(canCreateUsers({ uid: 1000, hasSudo: true }), true)
  assert.equal(canCreateUsers({ uid: 1000, hasSudo: false }), false)
  assert.match(createUserCommand('dshnc'), /^sudo useradd .*dshnc$/)
})

test('wizard: user scope, the answers land in the unit', async () => {
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

test('wizard: system scope with a dedicated user', async () => {
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

test('the wizard answers are applied to the config', () => {
  const config = { name: 'host' }
  applyAutostartAnswers(config, { name: 'nbw', aliases: ['nbw', 'laptop'] })
  assert.equal(config.name, 'nbw')
  assert.deepEqual(config.aliases, ['nbw', 'laptop'])
})

test('the state directory depends on the scope', () => {
  assert.match(stateDirFor({ scope: 'system', user: 'dshnc', home: '/home/dshnc' }), /^\/home\/dshnc\/\.dshnc$/)
  assert.match(stateDirFor({ scope: 'user' }), /\.dshnc$/)
})

test('ExecStart for .mjs carries the interpreter', async () => {
  const { resolveExecStart } = await import('../lib/autostart.mjs')
  assert.equal(resolveExecStart('/usr/local/bin/dshnc', '/usr/bin/node'), '/usr/local/bin/dshnc')
  assert.equal(
    resolveExecStart('/opt/dshnc/bin/dshnc.mjs', '/usr/bin/node'),
    '/usr/bin/node /opt/dshnc/bin/dshnc.mjs',
  )
})

test('the user is created automatically when there are rights', async () => {
  const { createUser } = await import('../lib/autostart.mjs')
  const calls = []
  const run = (file, args) => {
    calls.push([file, ...args])
    return { status: 0 }
  }
  assert.equal(createUser({ user: 'dshnc', uid: 0, run }), true)
  assert.deepEqual(calls.pop().slice(0, 3), ['useradd', '--system', '--create-home'])
  assert.equal(createUser({ user: 'dshnc', uid: 1000, hasSudo: true, run }), true)
  assert.deepEqual(calls.pop().slice(0, 3), ['sudo', '-n', 'useradd'])
  assert.equal(createUser({ user: 'dshnc', uid: 1000, hasSudo: false, run }), false)
  assert.equal(calls.length, 0, 'без прав ничего не запускаем')
})

test('wizard: without rights it prints the command and waits for the user', async () => {
  const answers = ['lamp', '', 'system', 'y', 'dshnc-new-user', '']
  const lines = []
  const result = await runAutostart({
    ask: async () => answers.shift() ?? '',
    print: (line) => lines.push(line),
    config: { name: 'host', aliases: [], servers: {} },
    execStart: '/usr/bin/dshnc',
    unitFile: (scope, name) => join(dir, `wait-${name}.service`),
    hasSudo: false,
    uid: 1000,
    run: () => ({ status: 1 }),
  })
  assert.equal(result.user, 'dshnc-new-user')
  assert.ok(lines.some((line) => /useradd/.test(line)), 'должна быть готовая команда для человека')
})

test('wizard asks about moving the token when there is one', async () => {
  const answers = ['lamp', '', 'system', 'y', 'dshnc-copy', 'y']
  const lines = []
  const asked = []
  const source = join(dir, 'source-state')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'config.json'), JSON.stringify({ id: 'x', servers: {} }))
  const result = await runAutostart({
    ask: async (question) => {
      asked.push(question)
      return answers.shift() ?? ''
    },
    print: (line) => lines.push(line),
    config: { name: 'host', aliases: [], servers: { 'http://x/dsh-nodes': { token: 'tok' } } },
    execStart: '/usr/bin/dshnc',
    unitFile: (scope, name) => join(dir, `copy-${name}.service`),
    hasSudo: true,
    run: () => ({ status: 0 }),
    stateFrom: source,
    stateTo: join(dir, 'target-state'),
  })
  assert.ok(asked.some((question) => /Move the current state|перенести|搬到/i.test(question)), 'должен быть вопрос про перенос')
  assert.equal(result.copied, true, 'перенос должен удаться при подменённом run')
})

test('without a token the wizard does not offer a move but says what to do', async () => {
  const answers = ['lamp', '', 'system', 'y', 'dshnc-notoken']
  const lines = []
  const result = await runAutostart({
    ask: async () => answers.shift() ?? '',
    print: (line) => lines.push(line),
    config: { name: 'host', aliases: [], servers: {} },
    execStart: '/usr/bin/dshnc',
    unitFile: (scope, name) => join(dir, `nt-${name}.service`),
    hasSudo: true,
    run: () => ({ status: 0 }),
  })
  assert.equal(result.copied, null)
  assert.ok(lines.some((line) => /connect <link>|connect <ссылк|connect <链接/.test(line)))
})

test('the unit has a PATH with the node directory', () => {
  const text = renderUnit({
    scope: 'user',
    execStart: '/opt/node/bin/node /opt/dshnc/bin/dshnc.mjs',
    pathEnv: '/opt/node/bin:/usr/bin:/bin',
  })
  assert.match(text, /^Environment=PATH=\/opt\/node\/bin:\/usr\/bin:\/bin$/m)
  assert.match(text, /^ExecStart=\/opt\/node\/bin\/node \/opt\/dshnc\/bin\/dshnc\.mjs daemon$/m)
})

test('environment import does not spam warnings about unset variables', () => {
  const text = renderUnit({ scope: 'user', execStart: '/usr/bin/dshnc', graphical: true })
  assert.match(text, /ExecStartPre=-\/bin\/sh -c 'systemctl --user import-environment/)
  assert.match(text, /2>\/dev\/null \|\| true/)
})

test('the unit can reload via SIGHUP', async () => {
  const { renderUnit } = await import('../lib/autostart.mjs')
  const text = renderUnit({ scope: 'user', execStart: '/usr/bin/dshnc', args: ['daemon'], graphical: false })
  assert.match(text, /ExecReload=\/bin\/kill -HUP \$MAINPID/)
})
