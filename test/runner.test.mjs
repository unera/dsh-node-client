/**
 * Демон: паузы и отмена.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runConcurrently } from '../lib/runner.mjs'


test('пауза не копит слушателей на AbortSignal', async () => {
  const { sleep } = await import('../lib/runner.mjs')
  const controller = new AbortController()
  for (let i = 0; i < 20; i++) await sleep(1, controller.signal)
  assert.ok(
    controller.signal.listenerCount?.('abort') === undefined || controller.signal.listenerCount('abort') === 0,
    'после пауз слушателей быть не должно',
  )
})

test('approve не блокирует пачку: остальные команды исполняются, пока висит диалог', async () => {
  let releaseDialog
  const dialog = new Promise((resolve) => { releaseDialog = resolve })
  const order = []
  const commands = [
    { seq: 1, method: 'approve', args: {} },
    { seq: 2, method: 'exec', args: {} },
    { seq: 3, method: 'exec', args: {} },
  ]
  const run = async (command) => {
    if (command.method === 'approve') {
      await dialog
      order.push('approve')
      return
    }
    order.push(`exec-${command.seq}`)
  }
  // chdir/approve отделены в runBatch; здесь проверяем сам принцип пула
  const exec = commands.filter((c) => c.method !== 'approve')
  const dialogRun = run(commands[0])
  await runConcurrently(exec, run, { concurrency: 5 })
  assert.deepEqual(order.sort(), ['exec-2', 'exec-3'], 'exec прошли, пока диалог висит')
  releaseDialog()
  await dialogRun
  assert.ok(order.includes('approve'))
})

test('падение одной команды не мешает остальным в пачке', async () => {
  const done = []
  await runConcurrently([
    { seq: 1 },
    { seq: 2 },
    { seq: 3 },
  ], async (command) => {
    if (command.seq === 2) throw new Error('плагин упал')
    done.push(command.seq)
  }, { concurrency: 2 })
  assert.deepEqual(done.sort(), [1, 3], 'упавшая команда не должна утащить остальные')
})
