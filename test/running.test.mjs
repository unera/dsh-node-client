/**
 * Реестр отменяемых процессов: без него `#INTERNAL.CANCEL` приходит в пустоту.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cancelRunning, forgetRunning, registerRunning, runningCount } from '../lib/running.mjs'
import * as shell from '../lib/plugins/shell.mjs'

const payload = (outcome) => JSON.parse(outcome.results[0].text)

test('отмена зовёт умение убить и не притворяется', () => {
  let killed = 0
  registerRunning(7, { kill: () => { killed += 1 } })
  assert.equal(payload(cancelRunning(7)).cancelled, true)
  assert.equal(killed, 1)
  // второй раз останавливать нечего, и это не ошибка
  assert.equal(payload(cancelRunning(7)).cancelled, false)
  assert.equal(payload(cancelRunning(7)).reason, 'no_such_process')
})

test('forget снимает запись: команда закончилась сама', () => {
  registerRunning(8, { kill: () => {} })
  assert.equal(runningCount(), 1)
  forgetRunning(8)
  assert.equal(payload(cancelRunning(8)).cancelled, false)
})

test('exec попадает в реестр и отменяется по номеру команды', async () => {
  const started = Date.now()
  const pending = shell.handle(
    { seq: 4242, method: 'exec', args: { command: 'sleep 30' }, timeout: 60 },
    { sandbox: null },
  )
  // дать процессу подняться
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

test('после обычного завершения exec из реестра убирается', async () => {
  const outcome = await shell.handle({ seq: 4243, method: 'exec', args: { command: 'true' }, timeout: 10 }, { sandbox: null })
  assert.equal(outcome.ok, true)
  assert.equal(payload(cancelRunning(4243)).cancelled, false, 'опаздывающая отмена никого не находит — и это нормально')
})
