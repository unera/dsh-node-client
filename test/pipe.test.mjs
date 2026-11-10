import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pipeArgs, pipeOutcome, stderrTail, PIPE_LIMITS } from '../lib/pipe.mjs'

test('pipe arguments: a command and a path on the server are required', () => {
  assert.throws(() => pipeArgs({ hostPath: '/tmp/a' }, 'from'), /команда/)
  assert.throws(() => pipeArgs({ command: 'ls' }, 'from'), /hostPath/)
  assert.throws(() => pipeArgs({ command: 'ls' }, 'to'), /hostPath/)
})

test('timeout: none by default, an explicit one is not trimmed', () => {
  // no limit: a backup can run long, and a ceiling only gets in the way here
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y' }, 'from').timeoutMs, 0)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 5 }, 'from').timeoutMs, 5000)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeoutMs: 7000 }, 'from').timeoutMs, 7000)
  // a day is a legitimate value, we do not trim anything
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 86_400 }, 'from').timeoutMs, 86_400_000)
  // zero and negative mean no limit
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 0 }, 'from').timeoutMs, 0)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: -1 }, 'from').timeoutMs, 0)
})

test('success: code 0 means the file is good, even if the output is empty', () => {
  const outcome = pipeOutcome({ exitCode: 0, bytes: 0, stderrTail: '' }, 'from')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.bytes, 0)
})

test('script failed: we tell the exit code from the stderr tail', () => {
  const outcome = pipeOutcome({ exitCode: 2, bytes: 10, stderrTail: 'нет такого файла' }, 'from')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'exit_nonzero')
  assert.match(outcome.message, /код 2/)
  assert.match(outcome.message, /нет такого файла/)
})

test('killed by a signal and a timeout are different reasons', () => {
  assert.equal(pipeOutcome({ exitCode: null, signal: 'SIGKILL', bytes: 0 }, 'from').code, 'killed_by_signal')
  assert.equal(pipeOutcome({ exitCode: null, timedOut: true, bytes: 5 }, 'from').code, 'timeout')
})

test('in the to direction an empty pass means the receiver stopped, not an error', () => {
  const outcome = pipeOutcome({ exitCode: 0, bytes: 0 }, 'to')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.stoppedBySink, true)
})

test('the stderr tail is bounded', () => {
  const long = 'x'.repeat(10_000)
  assert.equal(stderrTail(long).length, PIPE_LIMITS.stderrTail)
  assert.equal(stderrTail('коротко'), 'коротко')
})

test('cancellation: no target is a success, not an error', async () => {
  const { cancelRunning } = await import('../lib/plugins/pipe-run.mjs')
  const outcome = cancelRunning(999)
  assert.equal(outcome.ok, true)
  const payload = JSON.parse(outcome.results[0].text)
  assert.equal(payload.cancelled, false)
  assert.equal(payload.reason, 'no_such_process')
})


test('#INTERNAL.FLUSH waits until the pool is empty and only then answers', async () => {
  const { handleControl } = await import('../lib/plugins/shell.mjs')
  let drained = false
  let release
  const drain = () => new Promise((resolve) => { release = () => { drained = true; resolve() } })
  const pending = handleControl({ method: '#INTERNAL.FLUSH', args: {} }, { drain })
  let settled = false
  void pending.then(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(settled, false, 'пока пул занят, барьер молчит')
  release()
  const answer = await pending
  assert.equal(answer.ok, true)
  assert.equal(drained, true)
  assert.equal(JSON.parse(answer.results[0].text).flushed, true)
})

test('#INTERNAL.FLUSH on an empty pool is a success, not a wait', async () => {
  const { handleControl } = await import('../lib/plugins/shell.mjs')
  const answer = await handleControl({ method: '#INTERNAL.FLUSH', args: {} }, { drain: async () => {} })
  assert.equal(answer.ok, true)
  assert.equal(JSON.parse(answer.results[0].text).flushed, true)
})

