/**
 * A question to the human: the control command `#INTERNAL.APPROVE`.
 *
 * Approval is not a node method but a server operation: the node only shows the
 * question and returns the answer. That is why the command lives in the control
 * namespace, does not need to be declared in the API, and does not depend on the
 * `session` contract.
 *
 * A dialogue can hang indefinitely (the server sets the time limit), so the
 * command is obliged to be cancellable: `#INTERNAL.CANCEL` for its number arrives
 * as an ordinary command, and the `running` registry knows what to do — abort the
 * signal. Through it `askLocally` shuts the dialogue process down (SIGTERM) and
 * returns `cancelled`.
 *
 * @module dsh-node-client/approve-command
 */
import { forgetRunning, registerRunning } from './running.mjs'
import { t } from './i18n.mjs'

/** Open dialogues: needed to close them when the server generation changes. */
const active = new Set()

/** Close every open question (the server restarted — there is nothing to ask). */
export function abortAllApprovals () {
  for (const controller of active) {
    try {
      controller.abort()
    } catch {}
  }
  active.clear()
}

/** How many questions are open right now — for diagnostics and tests. */
export function activeApprovals () {
  return active.size
}

/**
 * Run `#INTERNAL.APPROVE`.
 *
 * @param {{seq: number, args?: object, session?: string, question?: object, timeout?: number}} command
 * @param {{approver?: {command?: string, run?: Function}, signal?: AbortSignal}} ctx
 * @returns {Promise<object>} command outcome
 */
export async function handleApproveCommand (command, ctx = {}) {
  const tool = ctx.approver?.command
  if (!tool) {
    return { ok: false, code: 'no_local_approver', message: t('approve.noTool'), results: null }
  }
  const args = command.args ?? {}
  const prompt = String(args.text ?? '')
  // identifiers for the question tool: through them the dialogue can remember
  // "answer yes until the end of the question" and "until the end of the session"
  const payload = JSON.stringify({
    id: args.id,
    mode: args.mode ?? null,
    text: prompt,
    session: command.session ?? null,
    question: command.question ?? null,
  })

  const controller = new AbortController()
  const onCtxAbort = () => controller.abort()
  ctx.signal?.addEventListener?.('abort', onCtxAbort, { once: true })
  active.add(controller)
  // `#INTERNAL.CANCEL` for this number must find the dialogue, not emptiness
  registerRunning(command.seq, { kill: () => controller.abort() })

  const started = Date.now()
  try {
    const verdict = await ctx.approver.run({
      tool,
      prompt,
      payload,
      signal: controller.signal,
      timeout: command.timeout,
    })
    return {
      ok: true,
      code: verdict ? 'approved' : 'cancelled',
      message: verdict ? 'ok' : 'cancel',
      results: [{
        type: 'text',
        text: JSON.stringify({ approved: Boolean(verdict), seconds: Math.round((Date.now() - started) / 1000) }),
      }],
    }
  } catch (error) {
    return { ok: false, code: error.code ?? 'approve_failed', message: error.message, results: null }
  } finally {
    active.delete(controller)
    forgetRunning(command.seq)
    ctx.signal?.removeEventListener?.('abort', onCtxAbort)
  }
}
