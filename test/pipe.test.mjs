import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pipeArgs, pipeOutcome, stderrTail, PIPE_LIMITS } from '../lib/pipe.mjs'

test('аргументы пайпа: нужны команда и путь на сервере', () => {
  assert.throws(() => pipeArgs({ hostPath: '/tmp/a' }, 'from'), /команда/)
  assert.throws(() => pipeArgs({ command: 'ls' }, 'from'), /hostPath/)
  assert.throws(() => pipeArgs({ command: 'ls' }, 'to'), /hostPath/)
})

test('таймаут: секунды и миллисекунды, с потолком', () => {
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y' }, 'from').timeoutMs, PIPE_LIMITS.timeoutMs.default)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 5 }, 'from').timeoutMs, 5000)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeoutMs: 7000 }, 'from').timeoutMs, 7000)
  // больше потолка — урезаем, меньше секунды — поднимаем: иначе смысла нет
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 99_999 }, 'from').timeoutMs, PIPE_LIMITS.timeoutMs.max)
  assert.equal(pipeArgs({ command: 'x', hostPath: '/y', timeout: 0.1 }, 'from').timeoutMs, 1000)
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
