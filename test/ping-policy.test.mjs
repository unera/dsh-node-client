/**
 * Расписание пинга: чистая арифметика, без сети.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pingDelay, pingMultiplier } from '../lib/ping-policy.mjs'

test('первые пять интервалов без команд пауза не растёт', () => {
  for (let ticks = 0; ticks < 5; ticks++) {
    assert.equal(pingMultiplier({ ticks, factor: 10 }), 1, `ticks=${ticks}`)
  }
})

test('потом растёт: ×2, ×3, и упирается в потолок', () => {
  assert.equal(pingMultiplier({ ticks: 5, factor: 10 }), 2)
  assert.equal(pingMultiplier({ ticks: 6, factor: 10 }), 3)
  assert.equal(pingMultiplier({ ticks: 9, factor: 10 }), 6)
  assert.equal(pingMultiplier({ ticks: 50, factor: 10 }), 10, 'потолок factor')
  assert.equal(pingMultiplier({ ticks: 50, factor: 3 }), 3)
})

test('factor 0 означает «не растягивать»', () => {
  assert.equal(pingMultiplier({ ticks: 20, factor: 0 }), 1)
  assert.equal(pingMultiplier({ ticks: 20, factor: null }), 1)
})

test('пауза в миллисекундах и выключение через 0', () => {
  assert.equal(pingDelay({ pingInterval: 15, factor: 10, ticks: 0 }), 15_000)
  assert.equal(pingDelay({ pingInterval: 15, factor: 10, ticks: 6 }), 45_000)
  assert.equal(pingDelay({ pingInterval: 0 }), 0, 'ноль выключает пинг')
  assert.equal(pingDelay({ pingInterval: null }), 0)
})
