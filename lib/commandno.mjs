/**
 * The command number the node claims to know.
 *
 * `max_commandno` is the last number the server spent, and numbers are honest: they grow by
 * one, are never reused, and a number spent on a command the node never saw (a cancel, a
 * timeout) stays spent.
 *
 * Hence the rule written down in `dsh-nodes/spec/CLIENT-LOOP.md` — the client **accepts the
 * number the server names**, both from the fetch answer and from a `state` frame, instead of
 * counting the maximum over the commands it received. Otherwise the hole in the numbering
 * never closes: the server has 5, the client remembers 4, and every `state` frame comes back
 * with another one — the server pushes whenever its number is higher.
 *
 * This is not the deleted cursor: nothing is filtered here, the number only stops a claim
 * from being false.
 *
 * @module dsh-node-client/commandno
 */

/**
 * @param {number} current the number this process knows so far
 * @param {number|null|undefined} named the server's `max_commandno`; null — it named none
 * @returns {number} the number to claim from now on, never backwards
 */
export function adoptCommandno (current, named) {
  // a server that names nothing is not a server that names zero
  if (typeof named !== 'number' || !Number.isFinite(named)) return current
  const known = Number(current)
  if (!Number.isFinite(known)) return named
  return Math.max(known, named)
}
