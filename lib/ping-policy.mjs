/**
 * Когда клиент пингует сервер по сокету и с какой паузой.
 *
 * Логика целиком в одной чистой функции, чтобы её можно было проверить тестом
 * без сети: расписание — это арифметика, а не побочный эффект.
 *
 * Правила:
 *  - пинг отправляется через `pingInterval` после последнего успешного
 *    общения (`lastSeen`);
 *  - если сервер давно не присылал команд (`lastCommand`), пауза растёт:
 *    первые пять интервалов она обычная, потом ×2, ×3 … но не больше
 *    `maxPingIntervalFactor`;
 *  - ответа нет в течение интервала — это разрыв, нужен реконнект.
 *
 * @module dsh-node-client/ping-policy
 */

/** После скольких интервалов без команд пауза начинает расти. */
export const GROW_AFTER_TICKS = 5

/**
 * Во сколько раз растянуть паузу.
 *
 * @param {object} options
 * @param {number} options.ticks сколько интервалов прошло без новых команд
 * @param {number} [options.factor] потолок растяжения; 0 или меньше — не растягивать
 * @returns {number} множитель, всегда >= 1
 */
export function pingMultiplier ({ ticks, factor = 0 }) {
  const cap = Number(factor) > 0 ? Number(factor) : 1
  if (ticks < GROW_AFTER_TICKS) return 1
  // 5 тиков → ×2, 6 → ×3, и так до потолка
  return Math.min(2 + (ticks - GROW_AFTER_TICKS), cap)
}

/**
 * Пауза до следующего пинга в миллисекундах.
 *
 * @param {object} options
 * @param {number} options.pingInterval секунды из конфига; 0 или меньше — выключено
 * @param {number} [options.factor] потолок растяжения
 * @param {number} [options.ticks] интервалов без команд
 * @returns {number} миллисекунды; 0 означает «пинг выключен»
 */
export function pingDelay ({ pingInterval, factor = 0, ticks = 0 }) {
  const base = Number(pingInterval)
  if (!Number.isFinite(base) || base <= 0) return 0
  return Math.round(base * pingMultiplier({ ticks, factor }) * 1000)
}
