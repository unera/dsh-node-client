/**
 * Registry of running processes: by command number — how to stop it.
 *
 * Needed by the control command `#INTERNAL.CANCEL`: the server cancels work not
 * with a word but with a number, and the node is obliged to find the live
 * process by it. The registry is shared by all plugins — otherwise `exec` could
 * not be cancelled at all, and it is the most common long-liver.
 *
 * What is stored is not the process but the ability to kill it: `exec` starts in
 * its own process group (`detached`), so the group is what must be killed, while
 * the pipe knows its own process.
 *
 * @module dsh-node-client/running
 */

/** @type {Map<string, {kill: () => void}>} */
const running = new Map()

/**
 * Remember by what the command is stopped.
 *
 * @param {number|string|null|undefined} seq command number
 * @param {{kill: () => void}} stopper
 */
export function registerRunning (seq, stopper) {
  if (seq === null || seq === undefined) return
  running.set(String(seq), stopper)
}

/** The command finished on its own: the record is no longer needed. */
export function forgetRunning (seq) {
  if (seq === null || seq === undefined) return
  running.delete(String(seq))
}

/** How many commands are in the registry now — for diagnostics and tests. */
export function runningCount () {
  return running.size
}

/**
 * Stop a command by its number.
 *
 * "Nothing to stop" is a success, not an error: the cancel may arrive after the
 * command has already finished, and that is a normal scenario (delivery of
 * control commands may be late).
 *
 * @param {number|string} seq
 * @returns {{ok: boolean, code?: string, message?: string, results: object[]}}
 */
export function cancelRunning (seq) {
  const target = running.get(String(seq))
  if (!target) {
    return {
      ok: true,
      results: [{ type: 'text', text: JSON.stringify({ cancelled: false, reason: 'no_such_process' }) }],
    }
  }
  try {
    target.kill()
    running.delete(String(seq))
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ cancelled: true, seq: Number(seq) }) }] }
  } catch (error) {
    return { ok: false, code: 'cancel_failed', message: `не смог остановить процесс ${seq}: ${error.message}`, results: [] }
  }
}
