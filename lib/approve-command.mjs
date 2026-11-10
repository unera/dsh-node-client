/**
 * Вопрос человеку: служебная команда `#INTERNAL.APPROVE`.
 *
 * Апрув — не метод узла, а операция сервера: узел только показывает вопрос и
 * возвращает ответ. Поэтому команда живёт в служебном пространстве имён, её не
 * надо объявлять в API, и она не зависит от контракта `session`.
 *
 * Диалог может висеть сколько угодно (сервер задаёт срок), поэтому команда
 * обязана уметь отменяться: `#INTERNAL.CANCEL` по её номеру приходит как
 * обычная команда, а регистр `running` знает, что делать, — оборвать сигнал.
 * По нему `askLocally` гасит процесс диалога (SIGTERM) и возвращает `cancelled`.
 *
 * @module dsh-node-client/approve-command
 */
import { forgetRunning, registerRunning } from './running.mjs'
import { t } from './i18n.mjs'

/** Открытые диалоги: нужны, чтобы закрыть их при смене поколения сервера. */
const active = new Set()

/** Закрыть все открытые вопросы (сервер перезапустился — спрашивать не о чем). */
export function abortAllApprovals () {
  for (const controller of active) {
    try {
      controller.abort()
    } catch {}
  }
  active.clear()
}

/** Сколько вопросов сейчас открыто — для диагностики и тестов. */
export function activeApprovals () {
  return active.size
}

/**
 * Исполнить `#INTERNAL.APPROVE`.
 *
 * @param {{seq: number, args?: object, session?: string, question?: object, timeout?: number}} command
 * @param {{approver?: {command?: string, run?: Function}, signal?: AbortSignal}} ctx
 * @returns {Promise<object>} исход команды
 */
export async function handleApproveCommand (command, ctx = {}) {
  const tool = ctx.approver?.command
  if (!tool) {
    return { ok: false, code: 'no_local_approver', message: t('approve.noTool'), results: null }
  }
  const args = command.args ?? {}
  const prompt = String(args.text ?? '')
  // идентификаторы для инструмента вопроса: по ним диалог может запомнить
  // «отвечать да до конца вопроса» и «до конца сессии»
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
  // `#INTERNAL.CANCEL` по этому номеру должен найти диалог, а не пустоту
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
