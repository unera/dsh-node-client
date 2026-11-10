/**
 * What to execute a command with on this platform.
 *
 * The model calls the `shell` API, not "bash": on Windows the same command goes to
 * PowerShell, and calling that bash would be a lie. Everything that depends on the
 * platform is gathered here: how to build argv, how to kill a process tree, and
 * whether there is a sandbox at all.
 *
 * @module dsh-node-client/shell
 */
import { spawn } from 'node:child_process'

/**
 * Time with precision better than a millisecond.
 *
 * `Date.now()` gives milliseconds, and for a ping within one network that is not
 * enough: a response is sometimes under a millisecond, and the clock difference
 * would drown in the rounding. `performance` gives fractions, but its origin is not
 * comparable between machines, so we add `timeOrigin` — that is ordinary wall clock
 * time already.
 *
 * @returns {number} milliseconds with fractions
 */
export function preciseNow () {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000
}

/** The platform we pick the implementation for. */
export const platform = process.platform

/** Whether the platform has a sandbox we know how to use. */
export const sandboxSupported = platform !== 'win32'

/**
 * Build argv for running a command line.
 *
 * @param {string} command command line from the model
 * @param {object} [options]
 * @param {string} [options.shell] path to the shell (POSIX)
 * @returns {{file: string, args: string[]}}
 */
export function shellArgv (command, { shell } = {}) {
  if (platform === 'win32') {
    // -NoProfile: someone else's profile changes behaviour and prints banners into
    // the output; -NonInteractive: otherwise the command may stall at a prompt
    return {
      file: process.env.DSHNC_POWERSHELL ?? 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', command],
    }
  }
  return { file: shell ?? '/bin/sh', args: ['-c', command] }
}

/**
 * Build argv with the sandbox — exactly as for an ordinary command.
 *
 * Jobs (`job`) take the same path as `exec`: in DSH a background process is the
 * same process, and the sandbox is applied at spawn. A different policy for
 * background work would mean that the node policy is bypassed with one line.
 *
 * @param {object} options
 * @param {string} options.command command line
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
  // the directory is set by the sandbox profile itself (--chdir), so `cwd` is not needed
  argv = ['bwrap', ...(sandbox.args ?? []), '--', base.file, ...base.args]
  return { argv, enforcement: 'bwrap' }
}

/**
 * Start a process so that it can be killed together with its descendants.
 *
 * POSIX: its own group (`detached`), the signal goes to the whole group via `-pid`.
 * Windows: there is no separate mechanism, so we kill the tree with `taskkill /T /F`.
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
    // own group only on POSIX: on Windows the flag means a different window (console)
    detached: platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/**
 * Kill a process together with its descendants.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} [signal]
 * @returns {boolean} whether the signal was sent
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
    // the minus means the process group: bwrap and everything it spawned dies with it
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
 * Exit code from a PowerShell result.
 *
 * `$LASTEXITCODE` exists only for external programs; if the command is a pure
 * cmdlet, PowerShell returns 0, and that is the right answer.
 *
 * @returns {string} command tail that prints the code
 */
export function exitCodeTail () {
  return platform === 'win32' ? '; exit $LASTEXITCODE' : ''
}
