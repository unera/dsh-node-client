/**
 * `dshnc autostart`: вопросы, юнит systemd, установка.
 *
 * Юнит собирается отдельной функцией, потому что ошибиться в systemd легко и
 * молча: не тот target, забытый `User=`, запуск в графической сессии без
 * переменных окружения. Текст юнита проверяется тестами, а не глазами.
 *
 * @module dsh-node-client/autostart
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { t } from './i18n.mjs'

/** Где живёт user-юнит и системный юнит. */
export const USER_UNIT_DIR = join(homedir(), '.config', 'systemd', 'user')
export const SYSTEM_UNIT_DIR = '/etc/systemd/system'

/**
 * Текст юнита.
 * @param {object} options
 * @param {'user'|'system'} options.scope
 * @param {string} options.execStart абсолютный путь к dshnc
 * @param {string[]} [options.args] аргументы (по умолчанию `daemon`)
 * @param {string} [options.user] `User=` для системного юнита
 * @param {string} [options.home] домашний каталог (для `Environment=HOME=`)
 * @param {boolean} [options.graphical] стартовать внутри графической сессии
 * @param {string} [options.shell] DSHNC_SHELL
 * @param {number} [options.restartSec]
 * @returns {string}
 */
export function renderUnit ({ scope, execStart, args = ['daemon'], user, home, graphical = false, shell = '/bin/bash', restartSec = 5 }) {
  const lines = ['[Unit]', `Description=${t('unit.description')}`]
  if (scope === 'system') {
    lines.push('After=network-online.target', 'Wants=network-online.target')
  } else if (graphical) {
    // запускаемся вместе с графической сессией и забираем её окружение
    lines.push('After=graphical-session.target', 'PartOf=graphical-session.target', 'Wants=graphical-session.target')
  } else {
    lines.push('After=network-online.target', 'Wants=network-online.target')
  }
  lines.push('', '[Service]')
  if (scope === 'system') {
    if (user) lines.push(`User=${user}`)
    if (home) lines.push(`Environment=HOME=${home}`)
  }
  lines.push(`Environment=DSHNC_SHELL=${shell}`)
  if (scope === 'user' && graphical) {
    // без этого DISPLAY/XAUTHORITY в user-юните пустые
    lines.push('ExecStartPre=-systemctl --user import-environment DISPLAY XAUTHORITY WAYLAND_DISPLAY XDG_RUNTIME_DIR')
  }
  lines.push(
    `ExecStart=${execStart} ${args.join(' ')}`.trim(),
    'Restart=always',
    `RestartSec=${restartSec}`,
    '',
    '[Install]',
    `WantedBy=${scope === 'user' && graphical ? 'graphical-session.target' : 'default.target'}`,
  )
  return lines.join('\n') + '\n'
}

/**
 * Чем на самом деле запускать: если нас вызвали как `node …/dshnc.mjs`, то
 * `ExecStart` должен нести интерпретатор и скрипт — на `.mjs` из юнита systemd
 * не запустит по shebang.
 * @param {string} script путь из `process.argv[1]`
 * @param {string} [execPath] путь к node (`process.execPath`)
 */
export function resolveExecStart (script, execPath = process.execPath) {
  if (!script) return execPath
  return script.endsWith('.mjs') ? `${execPath} ${script}` : script
}

/** Имя файла юнита. */
export function unitFileName (scope, name = 'dshnc') {
  return `${name}.service`
}

/** Путь к файлу юнита. */
export function unitPath (scope, name = 'dshnc', dir) {
  const base = dir ?? (scope === 'user' ? USER_UNIT_DIR : SYSTEM_UNIT_DIR)
  return join(base, unitFileName(scope, name))
}

/**
 * Записать юнит.
 * @returns {string} путь
 */
export function writeUnit ({ scope, name = 'dshnc', text, dir }) {
  const path = unitPath(scope, name, dir)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, { mode: 0o644 })
  return path
}

/** Команды, которые надо выполнить после записи файла. */
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

/** Есть ли у нас право создавать системных пользователей без вопросов. */
export function canCreateUsers ({ uid = process.getuid?.() ?? -1, hasSudo = false } = {}) {
  return uid === 0 || hasSudo
}

/**
 * Создать системного пользователя. Если мы root — сами, если есть sudo — через
 * него, иначе возвращаем false: тогда мастер покажет команду и подождёт.
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

/** Команда создания пользователя, которую можно показать человеку. */
export function createUserCommand (user, home = `/home/${user}`) {
  return `sudo useradd --system --create-home --home-dir ${home} --shell /usr/sbin/nologin ${user}`
}

/** Существует ли пользователь. */
export function userExists (user) {
  try {
    return readFileSync('/etc/passwd', 'utf8').split('\n').some((line) => line.startsWith(`${user}:`))
  } catch {
    return false
  }
}

/** Каталог состояния пользователя. */
export function stateDirFor ({ scope, user, home }) {
  if (scope === 'user' || !user) return join(homedir(), '.dshnc')
  return join(home ?? `/home/${user}`, '.dshnc')
}

/**
 * Мастер: задать вопросы, собрать юнит, записать его, показать команды установки.
 *
 * `ask` и `print` приходят снаружи — поэтому весь диалог проверяется тестом без
 * терминала. Копирование состояния делается только когда для системного юнита
 * создан отдельный пользователь: иначе он просто не найдёт токен.
 *
 * @param {object} options
 * @param {(question: string, fallback?: string) => Promise<string>} options.ask
 * @param {(line: string) => void} options.print
 * @param {object} options.config состояние клиента (name, aliases, servers)
 * @param {string} options.execStart путь к dshnc
 * @param {(scope: string, name: string) => string} [options.unitFile] переопределить путь (тесты)
 * @param {boolean} [options.hasSudo]
 * @param {number} [options.uid]
 */
export async function runAutostart ({ ask, print, config, execStart, unitFile, hasSudo = false, uid = process.getuid?.() ?? -1, run }) {
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
          print(`создан пользователь ${user}`)
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

  const text = renderUnit({ scope, execStart, user, home: home ?? undefined, graphical, shell: process.env.DSHNC_SHELL ?? '/bin/bash' })
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
  if (scope === 'system' && user) {
    const hasToken = Object.keys(config.servers ?? {}).length > 0
    if (hasToken) print(t('auto.copyConfig', { dir: stateDir }))
    else print(t('auto.noToken', { user }))
  }

  const commands = installCommands({ scope, name: 'dshnc' })
  print('')
  print(t('auto.next'))
  for (const command of commands) print('  ' + command)
  print('')
  print(t('auto.done'))

  return { name, aliases, scope, user, home, graphical, path, text, commands, stateDir }
}

/** Применить ответы к конфигу клиента. */
export function applyAutostartAnswers (config, { name, aliases }) {
  if (name) config.name = name
  config.aliases = aliasArray(aliases)
  return config
}

/** Привести алиасы к массиву строк. */
export function aliasArray (value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean)
  return []
}
