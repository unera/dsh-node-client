/**
 * Вопрос человеку как служебная команда: `#INTERNAL.APPROVE` и отмена по номеру.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { abortAllApprovals, activeApprovals, handleApproveCommand } from '../lib/approve-command.mjs'
import { cancelRunning } from '../lib/running.mjs'

const ctx = (behaviour) => ({ approver: { command: 'askpass', run: (options) => behaviour(options) } })
const payload = (outcome) => JSON.parse(outcome.results[0].text)

test('согласие человека — approved', async () => {
  const out = await handleApproveCommand({ seq: 1, args: { id: 'a', text: 'можно?' }, timeout: 60 },
    ctx(async ({ signal }) => {
      assert.equal(signal.aborted, false, 'диалог получает живой сигнал')
      return true
    }))
  assert.equal(out.code, 'approved')
  assert.equal(payload(out).approved, true)
  assert.equal(activeApprovals(), 0, 'после ответа диалог снят с учёта')
})

test('отказ человека — cancelled, а не ошибка', async () => {
  const out = await handleApproveCommand({ seq: 2, args: { id: 'b', text: 'нет?' }, timeout: 60 }, ctx(async () => false))
  assert.equal(out.code, 'cancelled')
  assert.equal(payload(out).approved, false)
})

test('#INTERNAL.CANCEL по номеру закрывает висящий вопрос', async () => {
  const pending = handleApproveCommand({ seq: 3, args: { id: 'c', text: '?' }, timeout: 600 },
    ctx(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('отменён'), { code: 'cancelled' })))
      void resolve
    })))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(activeApprovals(), 1, 'вопрос висит и ждёт человека')

  // ровно так приходит отмена: командой по номеру
  const cancelled = cancelRunning(3)
  assert.equal(payload(cancelled).cancelled, true, 'CANCEL обязан найти диалог, а не пустоту')

  const out = await pending
  assert.equal(out.ok, false)
  assert.equal(out.code, 'cancelled')
  assert.equal(activeApprovals(), 0)
})

test('смена поколения сервера закрывает открытые вопросы', async () => {
  let aborted = 0
  const dialogs = [4, 5].map((seq) => handleApproveCommand({ seq, args: { id: String(seq), text: '?' }, timeout: 600 },
    ctx(({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted += 1
        reject(Object.assign(new Error('aborted'), { code: 'cancelled' }))
      })
    }))))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(activeApprovals(), 2)
  abortAllApprovals()
  await Promise.all(dialogs)
  assert.equal(aborted, 2, 'вопросы, на которые уже некому ответить, закрываются')
  assert.equal(activeApprovals(), 0)
})

test('нет инструмента апрува — честная ошибка, а не тишина', async () => {
  const out = await handleApproveCommand({ seq: 6, args: { id: 'x', text: '?' } }, { approver: { command: null } })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'no_local_approver')
})
