/**
 * The client's sandbox: three modes on top of `bwrap`.
 *
 * The idea is not ours — it is taken from DSH (`@deepseek-ai/dsh-sandbox-local`,
 * MIT): the very same `bwrap` profile and the same tables of denial signatures live
 * there. We repeat the profile ourselves because their package pulls in cordis,
 * platform branches and 6 MB of policies, while we need 40 lines and predictable
 * behaviour.
 *
 * The main thing to understand about denial detection: **nothing is predicted**.
 * The command is started under isolation, the kernel itself refuses the write, and
 * only afterwards do we look at the exit code and stderr and decide whether this was
 * a sandbox denial.
 *
 * `LC_ALL=C` is mandatory: kernel messages are localized (the "read-only file
 * system" denial is printed in the language of the locale), and an English
 * signature would not match on a Russian locale. DSH does the same thing in
 * `dsh-subprocess-local`.
 *
 * @module dsh-node-client/sandbox
 */
import { spawnSync } from 'node:child_process'

/** Modes in ascending order of rights: narrower on the left, wider on the right. */
export const MODES = ['ro', 'rw', 'full']

/** Denial signatures that the kernel prints under `bwrap` (as in DSH). */
export const DENIAL_SIGNATURES = [
  'read-only file system',
  // the rw profile closes everything outside roots through ro-bind, and the kernel
  // answers not with "read-only" but with "permission denied". Without these two
  // lines a kernel denial looked like an ordinary command error, and the human was
  // never asked the question about widening.
  'permission denied',
  'operation not permitted',
]

/** Signs that the runner itself is broken: this is not a policy denial but "it did not start". */
export const RUNNER_SIGNATURES = ['bwrap: ']

/**
 * Mapping of our modes onto DSH modes — so that the texts and the escalation ladder
 * match what the model sees in the main DSH.
 */
export const DSH_MODES = { ro: 'read-only', rw: 'workspace-write', full: 'danger-full-access' }

/** The "strictly wider" ladder: what a mode may be raised to. */
export const WIDER_MODES = {
  ro: ['rw', 'full'],
  rw: ['full'],
  full: [],
}

/** Compare modes: return the narrower one (closer to ro). */
export function narrower (a, b) {
  return MODES.indexOf(a) <= MODES.indexOf(b) ? a : b
}

/**
 * The `bwrap` profile for a mode.
 *
 * - `ro`   — the whole host read-only, the network is cut off;
 * - `rw`   — plus writing to the workdir directory and to /tmp, the network is cut off;
 * - `full` — no profile, the command is started as is.
 *
 * @param {object} options
 * @param {'ro'|'rw'|'full'} options.mode
 * @param {string} [options.workdir] directory allowed for writing in rw mode
 * @param {string} [options.cwd] working directory of the command
 * @param {string[]} [options.mask] directories to hide (--tmpfs)
 * @returns {string[]} bwrap arguments up to `--`
 */
export function profileArgs ({ mode, workdir, writable = [], cwd, mask = [] }) {
  if (mode === 'full') return []
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-net',
    '--proc', '/proc',
    '--die-with-parent',
  ]
  for (const path of mask) args.push('--tmpfs', path)
  if (mode === 'rw') {
    args.push('--tmpfs', '/tmp')
    // writing is allowed into every root the owner allowed: a session can move to a
    // neighbouring directory (`session.chdir`), and it must stay writable, otherwise
    // rw turns into ro after the first move
    const targets = [...new Set([...(writable ?? []), workdir].filter(Boolean))]
    for (const path of targets) args.push('--bind', path, path)
  }
  if (cwd) args.push('--chdir', cwd)
  return args
}

let probeCache = null

/**
 * Whether `bwrap` works on this machine. Checked once per process: the `ro` profile
 * against itself, the command `true`. If it does not work, there is no isolation, and
 * the `ro`/`rw` modes are obliged to refuse rather than pretend that all is well.
 *
 * @returns {{available: boolean, version?: string, reason?: string}}
 */
export function probe (run = spawnSync) {
  if (probeCache) return probeCache
  const args = [...profileArgs({ mode: 'ro' }), '--', 'true']
  try {
    const result = run('bwrap', args, { timeout: 5000, stdio: 'ignore' })
    if (result.status === 0) {
      const version = run('bwrap', ['--version'], { timeout: 2000, encoding: 'utf8' })
      probeCache = { available: true, version: String(version.stdout ?? '').trim() }
    } else {
      probeCache = { available: false, reason: `bwrap вернул ${result.status}` }
    }
  } catch (error) {
    probeCache = { available: false, reason: error?.message ?? 'bwrap недоступен' }
  }
  return probeCache
}

/** Reset the probe cache (tests). */
export function resetProbe () {
  probeCache = null
}

/**
 * Interpret the result of a run: is it a sandbox denial, a broken runner, or an
 * ordinary command error.
 *
 * @param {object} options
 * @param {number|null} options.code exit code
 * @param {string} [options.stderr] stderr of the process
 * @param {'ro'|'rw'|'full'} options.mode
 * @param {string} [options.enforcement]
 * `denied` — the kernel refused access (signature in stderr), `failed` — the command
 * returned a non-zero code. These are different facts: a compound command may return
 * 0 although one of its parts was already rejected, and vice versa.
 *
 * @returns {{denied: boolean, failed: boolean, runnerFailure: boolean, signature: string|null}}
 */
export function classify ({ code, stderr = '', mode, enforcement = 'bwrap' }) {
  const text = String(stderr ?? '').toLowerCase()
  const signature = DENIAL_SIGNATURES.find((needle) => text.includes(needle)) ?? null
  const runnerFailure = RUNNER_SIGNATURES.some((needle) => text.includes(needle))
  // a denial counts only with a non-zero exit code: a command that merely printed
  // "read-only file system" is not considered a denial
  // The exit code is not required: `echo … ; echo …` on one line returns 0 although
  // the write was already rejected. The signature in stderr is the only reliable
  // sign, and a false positive costs one extra question.
  const denied = mode !== 'full' && !runnerFailure && signature !== null
  return { denied, failed: Number(code) !== 0, runnerFailure, signature: denied ? signature : null }
}

/** The "there is no isolation" error: the command must not run at all. */
export class SandboxUnavailableError extends Error {
  constructor (message, reason) {
    super(message)
    this.name = 'SandboxUnavailableError'
    this.code = 'sandbox_unavailable'
    this.reason = reason
  }
}
