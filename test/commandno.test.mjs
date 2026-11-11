/**
 * The number the node claims, as the protocol defines it.
 *
 * The loop this guards against is not in the frames: it is the claim. A node that restarts
 * while the server has already spent numbers claims less than the server knows, and the
 * server answers every `state` frame with a `state` frame of its own.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { adoptCommandno } from '../lib/commandno.mjs'

test('the number the server names is accepted', () => {
  assert.equal(adoptCommandno(0, 2), 2)
  assert.equal(adoptCommandno(2, 2), 2)
})

test('the claim never goes backwards', () => {
  assert.equal(adoptCommandno(9, 2), 9)
})

test('a server that names nothing changes nothing', () => {
  assert.equal(adoptCommandno(0, null), 0)
  assert.equal(adoptCommandno(4, undefined), 4)
  assert.equal(adoptCommandno(0, Number.NaN), 0)
})

test('the loop the panel showed us', () => {
  // a fresh process claims zero while the server has already spent two numbers
  let claimed = 0
  for (let i = 0; i < 3; i++) claimed = adoptCommandno(claimed, 2)
  assert.equal(claimed, 2, 'claim equal to the server number: the server stops pushing')
  // then command 3 arrives and is executed by the batch itself
  claimed = Math.max(claimed, 3)
  assert.equal(claim(claimed, 1), 3)
})

/** A tiny alias so the last assertion reads as the rule it checks. */
function claim (current, named) {
  return adoptCommandno(current, named)
}
