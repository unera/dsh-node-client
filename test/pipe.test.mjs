import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pipeArgs, pipeOutcome, stderrTail, PIPE_LIMITS } from '../lib/pipe.mjs'

test('аргументы пайпа: нужны команда и путь на сервере', () => {
  assert.throws(() => pipeArgs({ hostPath: '/tmp/a' }, 'from'), /команда/)
  assert.throws(() => pipeArgs({ command: 'ls' }, 'from'), /hostPath/)
  assert.throws(() => pipeArgs({ command: 'ls' }, 'to'), /hostPath/)
})

test('таймаут: по умолчанию нет, заданный не урезается', () => {
  // без ограничения: бэкап может идти долго, и потолок тут только мешает
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y' }, 'from').timeoutMs, 0)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 5 }, 'from').timeoutMs, 5000)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeoutMs: 7000 }, 'from').timeoutMs, 7000)
  // сутки — законное значение, ничего не режем
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 86_400 }, 'from').timeoutMs, 86_400_000)
  // ноль и отрицательное — без ограничения
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 0 }, 'from').timeoutMs, 0)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: -1 }, 'from').timeoutMs, 0)
})

test('успех: код 0 — файл годен, даже если вывод пустой', () => {
  const outcome = pipeOutcome({ exitCode: 0, bytes: 0, stderrTail: '' }, 'from')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.bytes, 0)
})

test('упал скрипт: различаем код выхода и хвост stderr', () => {
  const outcome = pipeOutcome({ exitCode: 2, bytes: 10, stderrTail: 'нет такого файла' }, 'from')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'exit_nonzero')
  assert.match(outcome.message, /код 2/)
  assert.match(outcome.message, /нет такого файла/)
})

test('убит сигналом и таймаут — разные причины', () => {
  assert.equal(pipeOutcome({ exitCode: null, signal: 'SIGKILL', bytes: 0 }, 'from').code, 'killed_by_signal')
  assert.equal(pipeOutcome({ exitCode: null, timedOut: true, bytes: 5 }, 'from').code, 'timeout')
})

test('в направлении to пустой проход — это остановка приёмником, а не ошибка', () => {
  const outcome = pipeOutcome({ exitCode: 0, bytes: 0 }, 'to')
  assert.equal(outcome.ok, true)
  assert.equal(outcome.stoppedBySink, true)
})

test('хвост stderr ограничен', () => {
  const long = 'x'.repeat(10_000)
  assert.equal(stderrTail(long).length, PIPE_LIMITS.stderrTail)
  assert.equal(stderrTail('коротко'), 'коротко')
})

test('отмена: нет цели — это успех, а не ошибка', async () => {
  const { cancelRunning } = await import('../lib/plugins/pipe-run.mjs')
  const outcome = cancelRunning(999)
  assert.equal(outcome.ok, true)
  const payload = JSON.parse(outcome.results[0].text)
  assert.equal(payload.cancelled, false)
  assert.equal(payload.reason, 'no_such_process')
})


test('#INTERNAL.FLUSH ждёт, пока опустеет пул, и только потом отвечает', async () => {
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

test('#INTERNAL.FLUSH на пустом пуле — успех, а не ожидание', async () => {
  const { handleControl } = await import('../lib/plugins/shell.mjs')
  const answer = await handleControl({ method: '#INTERNAL.FLUSH', args: {} }, { drain: async () => {} })
  assert.equal(answer.ok, true)
  assert.equal(JSON.parse(answer.results[0].text).flushed, true)
})

