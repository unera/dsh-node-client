/**
 * Демон: паузы и отмена.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'


test('пауза не копит слушателей на AbortSignal', async () => {
  const { sleep } = await import('../lib/runner.mjs')
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal)
  assert.ok(
    controller.signal.listenerCount?.('abort') === undefined || controller.signal.listenerCount('abort') === 0,
    'после пауз слушателей быть не должно',
  )
})
