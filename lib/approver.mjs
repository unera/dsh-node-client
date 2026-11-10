/**
 * Local approval: ask the human at this machine.
 *
 * Works through an external command from the node settings — `zenity`,
 * `notify-send`, `powershell`, anything. A separate module because it is easy to
 * get wrong here: the question text comes from outside (the server assembled it
 * from the model's command), and substituting it straight into a command line is
 * not allowed — that would be an injection.
 *
 * Hence: `%s` in the template is replaced with the escaped text, while the full
 * JSON goes to stdin. The command is started without a shell, as an argument list.
 *
 * @module dsh-node-client/approver
 */
import { spawn } from 'node:child_process'

/**
 * Arguments of the approval command.
 *
 * Two ways to pass the text:
 *  - the template contains `%s` → we substitute into the argument (for `zenity --question --text=%s`);
 *  - no `%s` → the text goes to stdin (for `zenity --text-info`), and then the
 *    question length is not limited by the command line at all.
 *
 * The split is done before the substitution: otherwise spaces from the question
 * would tear the argument apart. There is no shell here, so there is nothing to
 * escape.
 */
export function buildArgs (template, prompt) {
  const args = splitArgs(template)
  if (!template.includes('%s')) return args
  return args.map((arg) => arg.replaceAll('%s', String(prompt)))
}

/** Whether the text goes into the arguments or to stdin. */
export function usesStdin (template) {
  return !String(template).includes('%s')
}

/** Split a string into arguments, respecting quotes. */
export function splitArgs (template) {
  const args = []
  let current = ''
  let quote = null
  for (const char of template) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) args.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

/**
 * Ask the human.
 *
 * `ok` of the command means "I allow it": the tool is expected to ask the question
 * so that code 0 means consent (`zenity --question` returns 0 for "Yes"), and a
 * non-zero code means refusal or a closed window. The same behaviour is not
 * achievable with `notify-send` and actions, so such cases need a script of their
 * own — the config allows that.
 *
 * @param {object} options
 * @param {string} options.tool command from the settings
 * @param {string} options.prompt question text
 * @param {string} options.payload JSON for stdin
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout] seconds
 * @returns {Promise<boolean>} true — allowed
 */
export function askLocally ({ tool, prompt, payload, signal, timeout = 86400 }) {
  return new Promise((resolve, reject) => {
    const argv = buildArgs(tool, prompt)
    if (!argv.length) {
      reject(Object.assign(new Error('пустая команда апрува'), { code: 'no_local_approver' }))
      return
    }
    // structured data — into the environment, the text for the human — to stdin
    const env = {
      ...process.env,
      DSHNC_APPROVAL_ID: String(payload?.id ?? ''),
      DSHNC_APPROVAL_MODE: String(payload?.mode ?? ''),
      // what we are asking within: the session and the question (the turn's root call)
      DSHNC_SESSION: String(payload?.session ?? ''),
      DSHNC_QUESTION: String(payload?.question?.rootCallId ?? ''),
      DSHNC_CALL: String(payload?.question?.callId ?? ''),
    }
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'], env })
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {}
      finish(reject, Object.assign(new Error('апрув отменён'), { code: 'cancelled' }))
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
      finish(reject, Object.assign(new Error('апрув истёк'), { code: 'approve_timeout' }))
    }, Math.max(1, timeout) * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk
    })
    child.on('error', (error) => finish(reject, Object.assign(error, { code: 'approve_failed' })))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, true)
      else finish(resolve, false)
      void stderr
    })
    // the tool may not read stdin and exit at once — that is not an error
    child.stdin.on('error', () => {})
    try {
      // the dialogue needs human text; the JSON goes as environment variables
      child.stdin.end(usesStdin(tool) ? String(prompt) : String(payload))
    } catch {}
  })
}
