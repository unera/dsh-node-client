/**
 * Реестр исполняющихся процессов: по номеру команды — как её остановить.
 *
 * Нужен управляющей команде `#INTERNAL.CANCEL`: сервер отменяет работу не
 * словом, а номером, и узел обязан найти по нему живой процесс. Реестр общий
 * для всех плагинов — иначе `exec` нельзя отменить вовсе, а он и есть самый
 * частый долгожитель.
 *
 * Хранится не процесс, а умение его убить: `exec` запускается в своей группе
 * процессов (`detached`), и убивать надо группу, а пайп знает свой процесс.
 *
 * @module dsh-node-client/running
 */

/** @type {Map<string, {kill: () => void}>} */
const running = new Map()

/**
 * Запомнить, чем останавливается команда.
 *
 * @param {number|string|null|undefined} seq номер команды
 * @param {{kill: () => void}} stopper
 */
export function registerRunning (seq, stopper) {
  if (seq === null || seq === undefined) return
  running.set(String(seq), stopper)
}

/** Команда закончилась сама: запись больше не нужна. */
export function forgetRunning (seq) {
  if (seq === null || seq === undefined) return
  running.delete(String(seq))
}

/** Сколько команд сейчас в реестре — для диагностики и тестов. */
export function runningCount () {
  return running.size
}

/**
 * Остановить команду по номеру.
 *
 * «Нечего останавливать» — это успех, а не ошибка: отмена могла прийти после
 * того, как команда уже закончилась, и это штатный сценарий (доставка
 * управляющих команд может быть поздней).
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
