/**
 * Долгоиграющие процессы: запустил, получил id, читаешь вывод по смещению.
 *
 * Отдельно от `exec`, потому что контракт другой: `exec` отвечает результатом,
 * а здесь ответ — идентификатор, и дальше идут `output`, `kill`, `list`.
 * Смешивать это в одном методе пришлось бы аргументами вроде `background`,
 * половина которых бессмысленна в другом режиме.
 *
 * Модель повторяет поведение jobs в DSH: статус (`running`/`stopping`/
 * `completed`/`killed`/`failed`), кольцевой буфер вывода и убийство всей
 * группы процессов, а не одного pid.
 *
 * @module dsh-node-client/jobs
 */
import { randomBytes } from 'node:crypto'

import { killTree, spawnCommand } from './shell.mjs'

/** Сколько байт вывода держим на job: старое вытесняется. */
const RING_BYTES = 256 * 1024
/** Потолок одновременных job: иначе узел завалит сам себя. */
const MAX_JOBS = 8

/**
 * Реестр фоновых процессов клиента.
 * @param {object} [options]
 * @param {number} [options.ringBytes]
 * @param {number} [options.maxJobs]
 */
export function createJobRegistry ({ ringBytes = RING_BYTES, maxJobs = MAX_JOBS } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map()

  function running () {
    let count = 0
    for (const job of jobs.values()) if (job.status === 'running' || job.status === 'stopping') count++
    return count
  }

  /**
   * Запустить команду в фоне.
   * @param {object} options
   * @param {string} options.command
   * @param {string} [options.cwd]
   * @param {string} [options.shell]
   * @param {number} [options.timeout] секунды; 0 или пусто — без ограничения
   * @returns {{ok: boolean, results?: object[], code?: string, message?: string}}
   */
  function start ({ command, cwd, shell, timeout }) {
    if (typeof command !== 'string' || !command.trim()) {
      return { ok: false, code: 'bad_args', message: 'нужна команда' }
    }
    if (running() >= maxJobs) {
      return { ok: false, code: 'too_many_jobs', message: `уже работает ${running()} процессов, потолок ${maxJobs}` }
    }
    const id = `job-${randomBytes(8).toString('hex')}`
    const child = spawnCommand(command, { cwd, shell })
    const job = {
      id,
      command,
      cwd: cwd ?? null,
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      code: null,
      chunks: [],
      bytes: 0,
      dropped: 0,
      cursor: 0,
      child,
      timer: null,
    }
    const push = (type, text) => {
      if (!text) return
      const chunk = { at: job.bytes, type, text }
      job.chunks.push(chunk)
      job.bytes += Buffer.byteLength(text)
      // вытесняем старое, но так, чтобы смещения оставались абсолютными
      while (job.chunks.length > 1 && job.bytes - job.chunks[0].at > ringBytes) {
        const removed = job.chunks.shift()
        job.dropped += Buffer.byteLength(removed.text)
      }
    }
    child.stdout?.on('data', (chunk) => push('stdout', String(chunk)))
    child.stderr?.on('data', (chunk) => push('stderr', String(chunk)))
    child.on('error', (error) => {
      job.status = 'failed'
      job.message = error.message
      job.endedAt = Date.now()
    })
    child.on('close', (code, signal) => {
      if (job.timer) clearTimeout(job.timer)
      if (job.status === 'stopping') job.status = 'killed'
      else if (job.status !== 'failed') job.status = 'completed'
      job.code = code
      job.signal = signal ?? null
      job.endedAt = Date.now()
    })
    if (Number(timeout) > 0) {
      job.timer = setTimeout(() => killTree(child, 'SIGKILL'), Number(timeout) * 1000)
      if (typeof job.timer.unref === 'function') job.timer.unref()
    }
    jobs.set(id, job)
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ id, status: job.status }) }] }
  }

  /**
   * Прочитать вывод начиная с абсолютного смещения.
   * @param {string} id
   * @param {number} [offset] по умолчанию — с того места, где модель остановилась
   * @returns {{ok: boolean, results?: object[], code?: string, message?: string}}
   */
  function output (id, offset) {
    const job = jobs.get(id)
    if (!job) return { ok: false, code: 'no_such_job', message: `нет процесса ${id}` }
    const from = Number.isFinite(Number(offset)) ? Number(offset) : job.cursor
    const parts = job.chunks.filter((chunk) => chunk.at >= from)
    const text = parts.map((chunk) => chunk.text).join('')
    job.cursor = job.bytes
    return {
      ok: true,
      results: [{
        type: 'text',
        text: JSON.stringify({
          id: job.id,
          status: job.status,
          code: job.code ?? null,
          signal: job.signal ?? null,
          offset: job.bytes,
          dropped: job.dropped,
          tookMs: (job.endedAt ?? Date.now()) - job.startedAt,
          stdout: parts.filter((chunk) => chunk.type === 'stdout').map((chunk) => chunk.text).join(''),
          stderr: parts.filter((chunk) => chunk.type === 'stderr').map((chunk) => chunk.text).join(''),
        }),
      }],
    }
  }

  /** Попросить процесс завершиться, всей группой. */
  function kill (id, signal = 'SIGTERM') {
    const job = jobs.get(id)
    if (!job) return { ok: false, code: 'no_such_job', message: `нет процесса ${id}` }
    if (job.status !== 'running') {
      return { ok: true, results: [{ type: 'text', text: JSON.stringify({ id, status: job.status, changed: false }) }] }
    }
    job.status = 'stopping'
    killTree(job.child, signal)
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ id, status: job.status, signal }) }] }
  }

  /** Что сейчас запущено и чем кончилось (последние завершённые тоже видны). */
  function list () {
    const items = [...jobs.values()].map((job) => ({
      id: job.id,
      status: job.status,
      code: job.code ?? null,
      command: job.command.slice(0, 200),
      bytes: job.bytes,
      tookMs: (job.endedAt ?? Date.now()) - job.startedAt,
    }))
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ jobs: items }) }] }
  }

  /** Убить всё: нужно при остановке демона, иначе процессы переживут его. */
  function stopAll () {
    for (const job of jobs.values()) {
      if (job.status === 'running' || job.status === 'stopping') {
        job.status = 'stopping'
        killTree(job.child, 'SIGTERM')
      }
    }
  }

  return { start, output, kill, list, stopAll, get size () { return jobs.size } }
}
