/**
 * `dshnc autostart`: questions, the systemd unit, installation.
 *
 * The unit is assembled by a separate function, because getting systemd wrong is easy
 * and silent: the wrong target, a forgotten `User=`, starting inside a graphical
 * session without the environment variables. The unit text is verified by tests, not
 * by eye.
 *
 * @module dsh-node-client/autostart
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { t } from './i18n.mjs'

/** Where the user unit and the system unit live. */
export const USER_UNIT_DIR = join(homedir(), '.config', 'systemd', 'user')
export const SYSTEM_UNIT_DIR = '/etc/systemd/system'

/**
 * The unit text.
 * @param {object} options
 * @param {'user'|'system'} options.scope
 * @param {string} options.execStart absolute path to dshnc
 * @param {string[]} [options.args] arguments (`daemon` by default)
 * @param {string} [options.user] `User=` for a system unit
 * @param {string} [options.home] home directory (for `Environment=HOME=`)
 * @param {boolean} [options.graphical] start inside a graphical session
 * @param {string} [options.shell] DSHNC_SHELL
 * @param {number} [options.restartSec]
 * @returns {string}
 */
export function renderUnit ({ scope, execStart, args = ['daemon'], user, home, graphical = false, shell = '/bin/bash', restartSec = 5, pathEnv }) {
  const lines = ['[Unit]', `Description=${t('unit.description')}`]
  if (scope === 'system') {
    lines.push('After=network-online.target', 'Wants=network-online.target')
  } else if (graphical) {
    // we start together with the graphical session and take its environment
    lines.push('After=graphical-session.target', 'PartOf=graphical-session.target', 'Wants=graphical-session.target')
  } else {
    lines.push('After=network-online.target', 'Wants=network-online.target')
  }
  lines.push('', '[Service]')
  if (scope === 'system') {
    if (user) lines.push(`User=${user}`)
    if (home) lines.push(`Environment=HOME=${home}`)
  }
  // The unit has its own PATH: node from nvm does not get in there, and `env: 'node'` fails
  lines.push(`Environment=PATH=${pathEnv ?? '/usr/local/bin:/usr/bin:/bin'}`)
  lines.push(`Environment=DSHNC_SHELL=${shell}`)
  if (scope === 'user' && graphical) {
    // without this DISPLAY/XAUTHORITY are empty in a user unit
    lines.push("ExecStartPre=-/bin/sh -c 'systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR 2>/dev/null || true'")
  }
  lines.push(
    `ExecStart=${execStart} ${args.join(' ')}`.trim(),
    // reload the config without breaking connections: `systemctl --user reload dshnc`
    'ExecReload=/bin/kill -HUP $MAINPID',
    'Restart=always',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    `WantedBy=${scope === 'user' && graphical ? 'graphical-session.target' : 'default.target'}`,
  )
  return lines.join('\n') + '\n'
}

/**
 * What to actually start it with: if we were invoked as `node …/dshnc.mjs`, then
 * `ExecStart` has to carry the interpreter and the script — systemd will not start a
 * `.mjs` from a unit via shebang.
 * @param {string} script path from `process.argv[1]`
 * @param {string} [execPath] path to node (`process.execPath`)
 */
export function resolveExecStart (script, execPath = process.execPath) {
  if (!script) return execPath
  return script.endsWith('.mjs') ? `${execPath} ${script}` : script
}

/** Name of the unit file. */
export function unitFileName (scope, name = 'dshnc') {
  return `${name}.service`
}

/** Path to the unit file. */
export function unitPath (scope, name = 'dshnc', dir) {
  const base = dir ?? (scope === 'user' ? USER_UNIT_DIR : SYSTEM_UNIT_DIR)
  return join(base, unitFileName(scope, name))
}

/**
 * Write the unit.
 * @returns {string} path
 */
export function writeUnit ({ scope, name = 'dshnc', text, dir }) {
  const path = unitPath(scope, name, dir)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, { mode: 0o644 })
  return path
}

/** Commands to run after the file is written. */
export function installCommands ({ scope, name = 'dshnc', graphUser }) {
  if (scope === 'user') {
    const prefix = graphUser ? `sudo -u ${graphUser} -i ` : ''
    return [
      ...(graphUser ? [] : ['systemctl --user daemon-reload']),
      `${prefix}systemctl --user enable --now ${name}`,
      `${prefix}systemctl --user status ${name} --no-pager`,
    ]
  }
  return [
    'sudo systemctl daemon-reload',
    `sudo systemctl enable --now ${name}`,
    `sudo systemctl status ${name} --no-pager`,
  ]
}

/** Whether we have the right to create system users without asking. */
export function canCreateUsers ({ uid = process.getuid?.() ?? -1, hasSudo = false } = {}) {
  return uid === 0 || hasSudo
}

/**
 * Create a system user. If we are root — ourselves, if there is sudo — through it,
 * otherwise return false: then the wizard shows the command and waits.
 * @param {object} options
 * @param {string} options.user
 * @param {string} [options.home]
 * @param {number} [options.uid]
 * @param {boolean} [options.hasSudo]
 * @param {(file: string, args: string[]) => {status: number|null}} [options.run]
 * @returns {boolean}
 */
export function createUser ({ user, home = `/home/${user}`, uid = process.getuid?.() ?? -1, hasSudo = false, run }) {
  const args = ['--system', '--create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', user]
  const exec = run ?? ((file, argv) => spawnSync(file, argv, { stdio: 'inherit' }))
  if (uid === 0) return exec('useradd', args).status === 0
  if (hasSudo) return exec('sudo', ['-n', 'useradd', ...args]).status === 0
  return false
}

/**
 * Move the client state to another user.
 * @param {object} options
 * @param {string} options.from source directory
 * @param {string} options.to destination directory
 * @param {string} options.user owner
 * @param {number} [options.uid]
 * @param {boolean} [options.hasSudo]
 * @param {(file: string, args: string[]) => {status: number|null}} [options.run]
 * @returns {boolean}
 */
export function copyState ({ from, to, user, uid = process.getuid?.() ?? -1, hasSudo = false, run }) {
  const exec = run ?? ((file, argv) => spawnSync(file, argv, { stdio: 'inherit' }))
  try {
    mkdirSync(to, { recursive: true, mode: 0o700 })
    for (const file of readdirSync(from)) {
      if (file === 'node_modules') continue
      const source = join(from, file)
      const target = join(to, file)
      const stat = statSync(source)
      if (stat.isDirectory()) {
        cpSync(source, target, { recursive: true })
      } else {
        copyFileSync(source, target)
        // the settings and the tokens are private; the rest keeps its mode
        chmodSync(target, file === 'config.yaml' || file === 'credentials.yaml' ? 0o600 : stat.mode & 0o777)
      }
    }
  } catch (error) {
    return false
  }
  const argv = ['-R', `${user}:${user}`, to]
  const result = uid === 0 ? exec('chown', argv) : hasSudo ? exec('sudo', ['-n', 'chown', ...argv]) : { status: 1 }
  return result.status === 0
}

/** The user creation command that can be shown to the human. */
export function createUserCommand (user, home = `/home/${user}`) {
  return `sudo useradd --system --create-home --home-dir ${home} --shell /usr/sbin/nologin ${user}`
}

/** Whether the user exists. */
export function userExists (user) {
  try {
    return readFileSync('/etc/passwd', 'utf8').split('\n').some((line) => line.startsWith(`${user}:`))
  } catch {
    return false
  }
}

/** State directory of the user. */
export function stateDirFor ({ scope, user, home }) {
  if (scope === 'user' || !user) return join(homedir(), '.dshnc')
  return join(home ?? `/home/${user}`, '.dshnc')
}

/**
 * The wizard: ask the questions, assemble the unit, write it, show the install
 * commands.
 *
 * `ask` and `print` come from outside — that is why the whole dialogue is covered by a
 * test without a terminal. The state is copied only when a separate user has been
 * created for the system unit: otherwise it simply would not find the token.
 *
 * @param {object} options
 * @param {(question: string, fallback?: string) => Promise<string>} options.ask
 * @param {(line: string) => void} options.print
 * @param {object} options.config client state (name, aliases, servers)
 * @param {string} options.execStart path to dshnc
 * @param {(scope: string, name: string) => string} [options.unitFile] override the path (tests)
 * @param {boolean} [options.hasSudo]
 * @param {number} [options.uid]
 */
export async function runAutostart ({ ask, print, config, execStart, unitFile, hasSudo = false, hasToken: knownToken = null, uid = process.getuid?.() ?? -1, run, stateFrom, stateTo }) {
  print(t('auto.title'))

  const name = (await ask(t('auto.name'), config.name ?? '')).trim() || config.name
  const aliasesRaw = await ask(t('auto.aliases'), (config.aliases ?? []).join(','))
  const aliases = aliasesRaw.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 8)

  const scopeAnswer = (await ask(t('auto.scope'), 'user')).trim().toLowerCase()
  const scope = scopeAnswer.startsWith('s') ? 'system' : 'user'

  let user = null
  let home = null
  let graphical = false

  if (scope === 'system') {
    const dedicated = (await ask(t('auto.dedicated'), 'n')).trim().toLowerCase().startsWith('y')
    if (dedicated) {
      user = (await ask(t('auto.username'), 'dshnc')).trim() || 'dshnc'
      home = `/home/${user}`
      if (!userExists(user)) {
        const command = createUserCommand(user, home)
        if (canCreateUsers({ uid, hasSudo }) && createUser({ user, home, uid, hasSudo, run })) {
          print(t('auto.userCreated', { user }))
        } else {
          print(t('auto.createUser'))
          print('  ' + command)
          await ask(t('auto.waitingUser', { user }))
          for (let attempt = 0; attempt < 120 && !userExists(user); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 500))
          }
        }
      }
    }
  } else {
    graphical = (await ask(t('auto.graphical'), 'n')).trim().toLowerCase().startsWith('y')
  }

  const pathEnv = [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':')
  const text = renderUnit({ scope, execStart, user, home: home ?? undefined, graphical, pathEnv, shell: process.env.DSHNC_SHELL ?? '/bin/bash' })
  // check that there is something to start: otherwise the unit would go into a crash loop
  const launcher = execStart.split(' ')[0]
  if (!existsSync(launcher)) {
    print(t('auto.noLauncher', { path: launcher }))
  }
  const path = unitFile ? unitFile(scope, 'dshnc') : unitPath(scope, 'dshnc')
  if (unitFile) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text, { mode: 0o644 })
  } else {
    writeUnit({ scope, text })
  }
  print(t('auto.written', { path }))

  const stateDir = stateDirFor({ scope, user, home })
  print(t('auto.stateDir', { dir: stateDir }))
  let copied = null
  if (scope === 'system' && user) {
    // tokens moved to credentials.yaml, so the caller tells us whether the node has
    // any: reading `config.servers` here means always "no token" after the split
    const hasToken = knownToken ?? Object.values(config.servers ?? {}).some((entry) => entry?.token)
    if (!hasToken) {
      // a daemon without a token is useless: we say plainly what to do
      print(t('auto.noToken', { user }))
    } else if ((await ask(t('auto.copyState', { dir: stateDir }), 'n')).trim().toLowerCase().startsWith('y')) {
      copied = copyState({ from: stateFrom ?? home_of_config(), to: stateTo ?? stateDir, user, uid, hasSudo, run })
      print(copied ? t('auto.copied', { dir: stateTo ?? stateDir }) : t('auto.copyFailed', { user, message: 'chown/copy' }))
    } else {
      print(t('auto.copySkip'))
    }
  }

  const commands = installCommands({ scope, name: 'dshnc' })
  print('')
  print(t('auto.next'))
  for (const command of commands) print('  ' + command)
  print('')
  print(t('auto.done'))

  return { name, aliases, scope, user, home, graphical, path, text, commands, stateDir, copied }
}

/** State directory of the current user. */
export function home_of_config () {
  return join(homedir(), '.dshnc')
}

/** Apply the answers to the client config. */
export function applyAutostartAnswers (config, { name, aliases }) {
  if (name) config.name = name
  config.aliases = aliasArray(aliases)
  return config
}

/** Reduce aliases to an array of strings. */
export function aliasArray (value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}
