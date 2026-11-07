/**
 * Фоновые процессы: запуск, чтение по смещению, убийство группы.
 */
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { test } from 'node:test'

import { createJobRegistry } from '../lib/jobs.mjs'

const text = (result) => JSON.parse(result.results[0].text)

test('start возвращает id сразу, а вывод дочитывается по смещению', async () => {
  const jobs = createJobRegistry()
  const started = jobs.start({ command: 'echo раз; sleep 0.15; echo два' })
  assert.equal(started.ok, true)
  const id = text(started).id
  assert.match(id, /^job-[0-9a-f]{16}$/)
  // сразу после старта процесс ещё идёт — ответ уже есть, это и есть смысл job
  assert.equal(text(started).status, 'running')

  await new Promise((resolve) => setTimeout(resolve, 400))
  const all = text(jobs.output(id))
  assert.equal(all.status, 'completed')
  assert.equal(all.code, 0)
  assert.match(all.stdout, /раз[\s\S]*два/)

  // повторное чтение с того же места ничего не отдаёт: смещение запомнено
  const again = text(jobs.output(id))
  assert.equal(again.stdout, '')
  assert.ok(again.offset > 0)
})

test('stdout и stderr не смешиваются', async () => {
  const jobs = createJobRegistry()
  const id = text(jobs.start({ command: 'echo в-выход; echo в-ошибку >&2' })).id
  await new Promise((resolve) => setTimeout(resolve, 300))
  const out = text(jobs.output(id))
  assert.match(out.stdout, /в-выход/)
  assert.match(out.stderr, /в-ошибку/)
  assert.doesNotMatch(out.stdout, /в-ошибку/)
})

test('kill убивает не только оболочку, но и внуков', async () => {
  const jobs = createJobRegistry()
  const marker = '/tmp/dshnc-job-kill-marker'
  rmSync(marker, { force: true })
  // внук пишет файл спустя секунду: если группу не убили, файл появится
  const id = text(jobs.start({ command: `sh -c '(sleep 1; echo жив > ${marker}) & wait'` })).id
  await new Promise((resolve) => setTimeout(resolve, 150))
  const killed = jobs.kill(id)
  assert.equal(killed.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 1300))
  const out = text(jobs.output(id))
  assert.equal(out.status, 'killed')
  assert.throws(() => readFileSync(marker), 'внук не должен был дожить до записи')
})

test('потолок процессов и неизвестный id отвечают внятно', () => {
  const jobs = createJobRegistry({ maxJobs: 1 })
  const first = jobs.start({ command: 'sleep 5' })
  assert.equal(first.ok, true)
  const second = jobs.start({ command: 'echo нет' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'too_many_jobs')
  assert.equal(jobs.output('job-нет').code, 'no_such_job')
  jobs.kill(text(first).id, 'SIGKILL')
})

test('список показывает живое и завершённое', async () => {
  const jobs = createJobRegistry()
  const id = text(jobs.start({ command: 'echo ок' })).id
  await new Promise((resolve) => setTimeout(resolve, 300))
  const list = text(jobs.list()).jobs
  assert.equal(list.length, 1)
  assert.equal(list[0].id, id)
  assert.equal(list[0].status, 'completed')
})
