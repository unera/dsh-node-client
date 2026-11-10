/**
 * Ping schedule: pure arithmetic, no network.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pingDelay, pingMultiplier } from '../lib/ping-policy.mjs'

test('the pause does not grow over the first five intervals without commands', () => {
  for (let ticks = 0; ticks < 5; ticks++) {
    assert.equal(pingMultiplier({ ticks, factor: 10 }), 1, `ticks=${ticks}`)
  }
})

test('then it grows: x2, x3, and hits the ceiling', () => {
  assert.equal(pingMultiplier({ ticks: 5, factor: 10 }), 2)
  assert.equal(pingMultiplier({ ticks: 6, factor: 10 }), 3)
  assert.equal(pingMultiplier({ ticks: 9, factor: 10 }), 6)
  assert.equal(pingMultiplier({ ticks: 50, factor: 10 }), 10, 'потолок factor')
  assert.equal(pingMultiplier({ ticks: 50, factor: 3 }), 3)
})

test('factor 0 means "do not stretch"', () => {
  assert.equal(pingMultiplier({ ticks: 20, factor: 0 }), 1)
  assert.equal(pingMultiplier({ ticks: 20, factor: null }), 1)
})

test('the pause in milliseconds and switching off with 0', () => {
  assert.equal(pingDelay({ pingInterval: 15, factor: 10, ticks: 0 }), 15_000)
  assert.equal(pingDelay({ pingInterval: 15, factor: 10, ticks: 6 }), 45_000)
  assert.equal(pingDelay({ pingInterval: 0 }), 0, 'ноль выключает пинг')
  assert.equal(pingDelay({ pingInterval: null }), 0)
})
