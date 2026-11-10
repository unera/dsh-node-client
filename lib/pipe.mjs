/**
 * Pipes: a command's stream instead of a file.
 *
 * Only arithmetic and decisions live here — the network and the processes live in
 * the shell plugin. Kept separate so that it can be covered by tests: it is
 * exactly these decisions that are easy to get wrong, and the mistake shows up as
 * "the file is there, but it is incomplete".
 *
 * @module dsh-node-client/pipe
 */

/** Limits, the same on both platforms. */
export const PIPE_LIMITS = {
  // 0 — no limit: a pipe often carries a backup, and bumping into a cap is
  // pointless. The caller sets a limit when one is needed.
  timeoutMs: { default: 0 },
  stderrTail: 4 * 1024,
}

/**
 * Parse pipe arguments.
 *
 * @param {object} args
 * @param {'from'|'to'} direction `from` — the node gives, `to` — the node takes
 * @returns {{command: string, hostPath: string, cwd: string|null, timeoutMs: number}}
 * @throws an error with a `code` field if the arguments are not good
 */
export function pipeArgs (args, direction) {
  const command = typeof args?.command === 'string' ? args.command.trim() : ''
  const hostPath = typeof args?.hostPath === 'string' ? args.hostPath.trim() : ''
  const fail = (code, message) => {
    throw Object.assign(new Error(message), { code })
  }
  if (!command) fail('bad_args', 'нужна команда: что выполнять')
  if (!hostPath) fail('bad_args', direction === 'from'
    ? 'нужен hostPath: куда на сервере положить вывод'
    : 'нужен hostPath: откуда на сервере брать данные')
  const raw = args?.timeoutMs ?? (args?.timeout != null ? Number(args.timeout) * 1000 : PIPE_LIMITS.timeoutMs.default)
  const value = Number(raw)
  // zero and garbage mean "no limit"; negative does too
  const timeoutMs = Number.isFinite(value) && value > 0 ? value : 0
  return {
    command,
    hostPath,
    cwd: typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null,
    timeoutMs,
  }
}

/**
 * Verdict on a finished pipe.
 *
 * We deliberately tell "the script failed" apart from "the script produced
 * nothing": empty output with exit code 0 is a legitimate result (`grep` with no
 * matches), not an error.
 *
 * @param {object} outcome
 * @param {number|null} outcome.exitCode exit code, or null if the process was killed
 * @param {string|null} [outcome.signal] signal name
 * @param {boolean} [outcome.timedOut]
 * @param {number} [outcome.bytes] how many bytes went through
 * @param {string} [outcome.stderrTail]
 * @param {'from'|'to'} direction
 * @returns {{ok: boolean, code?: string, message?: string, bytes: number}}
 */
export function pipeOutcome (outcome, direction) {
  const bytes = Number(outcome?.bytes ?? 0)
  const tail = String(outcome?.stderrTail ?? '').trim()
  const detail = tail ? `\n[stderr] ${tail}` : ''
  if (outcome?.timedOut) {
    return { ok: false, code: 'timeout', message: `команда не уложилась в срок${detail}`, bytes }
  }
  if (outcome?.signal) {
    return { ok: false, code: 'killed_by_signal', message: `процесс убит сигналом ${outcome.signal}${detail}`, bytes }
  }
  const code = outcome?.exitCode
  if (code !== 0) {
    return { ok: false, code: 'exit_nonzero', message: `код ${code}${detail}`, bytes }
  }
  // with direction `to` the script may have closed its input early: that is fine
  return { ok: true, bytes, ...(direction === 'to' && bytes === 0 ? { stoppedBySink: true } : {}) }
}

/** stderr tail: a long log must not take up the whole result. */
export function stderrTail (text, limit = PIPE_LIMITS.stderrTail) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(-limit)
}
