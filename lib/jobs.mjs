/**
 * Long-running processes: started one, got an id, read the output by offset.
 *
 * Separate from `exec` because the contract is different: `exec` answers with a
 * result, while here the answer is an identifier and then come `output`, `kill`,
 * `list`. Mixing this into one method would require arguments like `background`,
 * half of which are meaningless in the other mode.
 *
 * The model repeats the behaviour of jobs in DSH: status (`running`/`stopping`/
 * `completed`/`killed`/`failed`), a ring buffer for the output, and killing the
 * whole process group instead of a single pid.
 *
 * @module dsh-node-client/jobs
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { commandArgv, killTree, spawnCommand, platform } from './shell.mjs'

/** How many bytes of output we keep per job: the old is evicted. */
const RING_BYTES = 256 * 1024
/** Cap on simultaneous jobs: otherwise the node would bury itself. */
const MAX_JOBS = 8
/** How many finished ones we remember: they are used to look at what happened, but not forever. */
const MAX_FINISHED = 32

/**
 * Registry of the client's background processes.
 * @param {object} [options]
 * @param {number} [options.ringBytes]
 * @param {number} [options.maxJobs]
 */
export function createJobRegistry ({ ringBytes = RING_BYTES, maxJobs = MAX_JOBS } = {}) {
  /** @type {Map<string, object>} */
  const jobs = new Map()

  /** Drop old finished ones: the daemon lives for weeks, memory is not elastic. */
  function evictFinished () {
    const finished = [...jobs.values()]
      .filter((job) => job.status !== 'running' && job.status !== 'stopping')
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    while (finished.length > MAX_FINISHED) {
      const job = finished.shift()
      jobs.delete(job.id)
    }
  }

  function running () {
    let count = 0
    for (const job of jobs.values()) if (job.status === 'running' || job.status === 'stopping') count++
    return count
  }

  /**
   * Start a command in the background.
   * @param {object} options
   * @param {string} options.command
   * @param {string} [options.cwd]
   * @param {string} [options.shell]
   * @param {number} [options.timeout] seconds; 0 or empty — no limit
   * @returns {{ok: boolean, results?: object[], code?: string, message?: string}}
   */
  function start ({ command, cwd, shell, timeout, sandbox = null }) {
    if (typeof command !== 'string' || !command.trim()) {
      return { ok: false, code: 'bad_args', message: 'нужна команда' }
    }
    if (running() >= maxJobs) {
      return { ok: false, code: 'too_many_jobs', message: `уже работает ${running()} процессов, потолок ${maxJobs}` }
    }
    const id = `job-${randomBytes(8).toString('hex')}`
    // A job takes the same path as an ordinary command: if the node policy requires
    // a sandbox, the process is started inside it. Otherwise a background process
    // would be a way to bypass the policy with one line.
    const prepared = commandArgv({ command, shell, sandbox })
    if (prepared.error) return prepared.error
    const child = spawn(prepared.argv[0], prepared.argv.slice(1), {
      cwd: prepared.enforcement === 'bwrap' ? undefined : (cwd || process.cwd()),
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: platform !== 'win32',
    })
    const job = {
      id,
      command,
      cwd: cwd ?? null,
      status: 'running',
      sandbox: prepared.enforcement,
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
      // evict the old, but so that the offsets stay absolute
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
      evictFinished()
    })
    if (Number(timeout) > 0) {
      job.timer = setTimeout(() => killTree(child, 'SIGKILL'), Number(timeout) * 1000)
      if (typeof job.timer.unref === 'function') job.timer.unref()
    }
    jobs.set(id, job)
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ id, status: job.status }) }] }
  }

  /**
   * Read the output starting from an absolute offset.
   * @param {string} id
   * @param {number} [offset] by default — from where the model stopped
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
          sandbox: job.sandbox ?? 'none',
          stdout: parts.filter((chunk) => chunk.type === 'stdout').map((chunk) => chunk.text).join(''),
          stderr: parts.filter((chunk) => chunk.type === 'stderr').map((chunk) => chunk.text).join(''),
        }),
      }],
    }
  }

  /** Ask the process to finish, together with its whole group. */
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

  /** What is running now and how it ended (the latest finished ones are visible too). */
  function list () {
    const items = [...jobs.values()].map((job) => ({
      id: job.id,
      status: job.status,
      code: job.code ?? null,
      command: job.command.slice(0, 200),
      sandbox: job.sandbox,
      bytes: job.bytes,
      tookMs: (job.endedAt ?? Date.now()) - job.startedAt,
    }))
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ jobs: items }) }] }
  }

  /** Kill everything: needed when the daemon stops, otherwise the processes outlive it. */
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
