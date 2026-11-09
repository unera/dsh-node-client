/**
 * Пайпы: поток команды вместо файла.
 *
 * Здесь только арифметика и решения — сеть и процессы живут в плагине shell.
 * Вынесено отдельно, чтобы проверялось тестами: именно в этих решениях легко
 * ошибиться, а ошибка выглядит как «файл есть, но он неполный».
 *
 * @module dsh-node-client/pipe
 */

/** Пределы, одинаковые на обеих платформах. */
export const PIPE_LIMITS = {
  // 0 — без ограничения: пайп часто гоняет бэкап, и упираться в потолок
  // бессмысленно. Ограничение ставит тот, кто вызывает, если оно нужно.
  timeoutMs: { default: 0 },
  stderrTail: 4 * 1024,
}

/**
 * Разобрать аргументы пайпа.
 *
 * @param {object} args
 * @param {'from'|'to'} direction `from` — узел отдаёт, `to` — узел принимает
 * @returns {{command: string, hostPath: string, cwd: string|null, timeoutMs: number}}
 * @throws ошибка с полем `code`, если аргументы не годятся
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
  // ноль и мусор означают «без ограничения»; отрицательное — тоже
  const timeoutMs = Number.isFinite(value) && value > 0 ? value : 0
  return {
    command,
    hostPath,
    cwd: typeof args?.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null,
    timeoutMs,
  }
}

/**
 * Решение по завершённому пайпу.
 *
 * Отдельно различаем «скрипт упал» и «скрипт не отдал ничего»: пустой вывод при
 * коде 0 — это законный результат (`grep` без совпадений), а не ошибка.
 *
 * @param {object} outcome
 * @param {number|null} outcome.exitCode код выхода или null, если процесс убит
 * @param {string|null} [outcome.signal] имя сигнала
 * @param {boolean} [outcome.timedOut]
 * @param {number} [outcome.bytes] сколько байт прошло
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
  // при направлении `to` скрипт мог закрыть ввод раньше: это нормально
  return { ok: true, bytes, ...(direction === 'to' && bytes === 0 ? { stoppedBySink: true } : {}) }
}

/** Хвост stderr: длинный лог не должен занимать весь результат. */
export function stderrTail (text, limit = PIPE_LIMITS.stderrTail) {
  const value = String(text ?? '')
  return value.length <= limit ? value : value.slice(-limit)
}
