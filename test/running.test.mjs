/**
 * Registry of cancellable processes: without it `#INTERNAL.CANCEL` arrives into the void.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cancelRunning, forgetRunning, registerRunning, runningCount } from '../lib/running.mjs'
import * as shell from '../lib/plugins/shell.mjs'

const payload = (outcome) => JSON.parse(outcome.results[0].text)

test('cancellation calls the kill capability and does not pretend', () => {
  let killed = 0
  registerRunning(7, { kill: () => { killed += 1 } })
  assert.equal(payload(cancelRunning(7)).cancelled, true)
  assert.equal(killed, 1)
  // there is nothing left to stop the second time, and that is not an error
  assert.equal(payload(cancelRunning(7)).cancelled, false)
  assert.equal(payload(cancelRunning(7)).reason, 'no_such_process')
})

test('forget drops the record: the command finished by itself', () => {
  registerRunning(8, { kill: () => {} })
  assert.equal(runningCount(), 1)
  forgetRunning(8)
  assert.equal(payload(cancelRunning(8)).cancelled, false)
})

test('exec gets into the registry and is cancelled by command number', async () => {
  const started = Date.now()
  const pending = shell.handle(
    { seq: 4242, method: 'exec', args: { command: 'sleep 30' }, timeout: 60 },
    { sandbox: null },
  )
  // let the process come up
  await new Promise((resolve) => setTimeout(resolve, 300))
  const before = runningCount()
  assert.ok(before >= 1, 'exec обязан быть в реестре, пока идёт')
  assert.equal(payload(cancelRunning(4242)).cancelled, true, 'CANCEL должен находить exec')

  const outcome = await pending
  const spent = Date.now() - started
  assert.ok(spent < 10_000, `команда не должна дорабатывать свои 30 секунд, а вышло ${spent} мс`)
  assert.equal(outcome.ok, true, 'убитый процесс — это состоявшийся ответ, а не ошибка клиента')
  assert.equal(runningCount(), 0, 'после завершения записи быть не должно')
})

test('after a normal exit exec is removed from the registry', async () => {
  const outcome = await shell.handle({ seq: 4243, method: 'exec', args: { command: 'true' }, timeout: 10 }, { sandbox: null })
  assert.equal(outcome.ok, true)
  assert.equal(payload(cancelRunning(4243)).cancelled, false, 'опаздывающая отмена никого не находит — и это нормально')
})

test('cancelling the approval dialog: CANCEL by number closes the question', async () => {
  // this is how approve works on the client: its own AbortController, and in the registry
  // a capability to interrupt it. Timeout/abort arrive as a command, not as a signal
  const controller = new AbortController()
  let dialogCancelled = false
  controller.signal.addEventListener('abort', () => { dialogCancelled = true })

  registerRunning(5555, { kill: () => controller.abort() })
  const outcome = cancelRunning(5555)
  assert.equal(payload(outcome).cancelled, true, 'отмена должна найти диалог')
  assert.equal(dialogCancelled, true, 'вопрос обязан закрыться, а не висеть до утра')
  assert.equal(controller.signal.aborted, true)

  // and after the cancellation no record is left
  assert.equal(payload(cancelRunning(5555)).cancelled, false)
})
