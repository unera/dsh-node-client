/**
 * Чем исполнять команду на этой платформе.
 *
 * Модель зовёт API `shell`, а не «bash»: на Windows та же команда уходит в
 * PowerShell, и называть это bash было бы враньём. Здесь собрано всё, что
 * зависит от платформы: как собрать argv, как убить дерево процессов и есть ли
 * вообще песочница.
 *
 * @module dsh-node-client/shell
 */
import { spawn } from 'node:child_process'

/**
 * Время с точностью лучше миллисекунды.
 *
 * `Date.now()` даёт миллисекунды, а на пинге в пределах одной сети этого мало:
 * отклик бывает меньше миллисекунды, и разница часов утонула бы в округлении.
 * `performance` даёт доли, но его начало отсчёта не сравнимо между машинами,
 * поэтому складываем со `timeOrigin` — это уже обычное настенное время.
 *
 * @returns {number} миллисекунды с долями
 */
export function preciseNow () {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000
}

/** Платформа, для которой выбираем реализацию. */
export const platform = process.platform

/** Есть ли на платформе песочница, которой мы умеем пользоваться. */
export const sandboxSupported = platform !== 'win32'

/**
 * Собрать argv для запуска командной строки.
 *
 * @param {string} command командная строка от модели
 * @param {object} [options]
 * @param {string} [options.shell] путь к оболочке (POSIX)
 * @returns {{file: string, args: string[]}}
 */
export function shellArgv (command, { shell } = {}) {
  if (platform === 'win32') {
    // -NoProfile: чужой профиль меняет поведение и печатает баннеры в вывод;
    // -NonInteractive: иначе команда может встать на приглашении
    return {
      file: process.env.DSHNC_POWERSHELL ?? 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    }
  }
  return { file: shell ?? '/bin/sh', args: ['-c', command] }
}

/**
 * Собрать argv с песочницей — так же, как для обычной команды.
 *
 * Задания (`job`) идут тем же путём, что и `exec`: в DSH фоновый процесс — это
 * тот же процесс, и песочница применяется на спавне. Другая политика для
 * фоновой работы означала бы, что политика узла обходится одной строкой.
 *
 * @param {object} options
 * @param {string} options.command командная строка
 * @param {string} [options.shell]
 * @param {object|null} [options.sandbox] `{mode, args, probe}`
 * @returns {{argv: string[], enforcement: string, error?: object}}
 */
export function commandArgv ({ command, shell, sandbox = null }) {
  const base = shellArgv(command, { shell })
  let argv = [base.file, ...base.args]
  if (!sandbox || sandbox.mode === 'full') return { argv, enforcement: 'none' }
  if (!sandboxSupported) {
    return {
      argv,
      enforcement: 'none',
      error: { ok: false, code: 'sandbox_unavailable', message: `на платформе ${process.platform} песочницы нет: разрешён только режим full` },
    }
  }
  const probeResult = sandbox.probe?.() ?? { available: true }
  if (!probeResult.available) {
    return {
      argv,
      enforcement: 'none',
      error: { ok: false, code: 'sandbox_unavailable', message: probeResult.reason ?? 'bwrap недоступен', results: null },
    }
  }
  // каталог задаётся самим профилем песочницы (--chdir), поэтому `cwd` не нужен
  argv = ['bwrap', ...(sandbox.args ?? []), '--', base.file, ...base.args]
  return { argv, enforcement: 'bwrap' }
}

/**
 * Запустить процесс так, чтобы его можно было убить вместе с потомками.
 *
 * POSIX: своя группа (`detached`), сигнал всей группе через `-pid`.
 * Windows: отдельного механизма нет, поэтому убиваем дерево `taskkill /T /F`.
 *
 * @param {string} command
 * @param {object} [options]
 * @param {string} [options.cwd]
 * @param {object} [options.env]
 * @param {string} [options.shell]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnCommand (command, { cwd, env, shell } = {}) {
  const { file, args } = shellArgv(command, { shell })
  return spawn(file, args, {
    cwd: cwd || undefined,
    env: env ?? process.env,
    // своя группа только на POSIX: на Windows флаг означает другое окно
    detached: platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Убить процесс вместе с потомками.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 * @returns {boolean} удалось ли отправить сигнал
 */
export function killTree (child, signal = 'SIGTERM') {
  if (!child?.pid) return false
  if (platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
      return true
    } catch {
      return false
    }
  }
  try {
    // минус — это группа процессов: bwrap и всё, что он породил, умрёт вместе
    process.kill(-child.pid, signal)
    return true
  } catch {
    try {
      child.kill(signal)
      return true
    } catch {
      return false
    }
  }
}

/**
 * Код возврата из результата PowerShell.
 *
 * `$LASTEXITCODE` есть только у внешних программ; если команда — чистый
 * cmdlet, PowerShell вернёт 0, и это правильный ответ.
 *
 * @returns {string} хвост команды, который печатает код
 */
export function exitCodeTail () {
  return platform === 'win32' ? '; exit $LASTEXITCODE' : ''
}
