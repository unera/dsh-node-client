/**
 * When the client pings the server over the socket, and with what delay.
 *
 * The whole logic is one pure function so it can be tested without the network:
 * the schedule is arithmetic, not a side effect.
 *
 * Rules:
 *  - a ping is sent `pingInterval` after the last successful exchange
 *    (`lastSeen`);
 *  - if the server has not sent commands for a long time (`lastCommand`), the
 *    delay grows: for the first five intervals it stays normal, then ×2, ×3 …
 *    but never more than `maxPingIntervalFactor`;
 *  - no answer within the interval means the link is broken, a reconnect is
 *    needed.
 *
 * @module dsh-node-client/ping-policy
 */

/** After how many intervals without commands the delay starts to grow. */
export const GROW_AFTER_TICKS = 5

/**
 * How many times to stretch the delay.
 *
 * @param {object} options
 * @param {number} options.ticks how many intervals passed without new commands
 * @param {number} [options.factor] stretch cap; 0 or less — do not stretch
 * @returns {number} multiplier, always >= 1
 */
export function pingMultiplier ({ ticks, factor = 0 }) {
  const cap = Number(factor) > 0 ? Number(factor) : 1
  if (ticks < GROW_AFTER_TICKS) return 1
  // 5 ticks → ×2, 6 → ×3, and so on up to the cap
  return Math.min(2 + (ticks - GROW_AFTER_TICKS), cap)
}

/**
 * Delay until the next ping in milliseconds.
 *
 * @param {object} options
 * @param {number} options.pingInterval seconds from the config; 0 or less — disabled
 * @param {number} [options.factor] stretch cap
 * @param {number} [options.ticks] intervals without commands
 * @returns {number} milliseconds; 0 means "ping is disabled"
 */
export function pingDelay ({ pingInterval, factor = 0, ticks = 0 }) {
  const base = Number(pingInterval)
  if (!Number.isFinite(base) || base <= 0) return 0
  return Math.round(base * pingMultiplier({ ticks, factor }) * 1000)
}
