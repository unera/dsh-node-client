/**
 * Executor of a single command: bash.
 *
 * The result is `content` blocks in the MCP form (`text`), the way the server
 * expects them (plan §4.5). We do not cut large output in the middle of a line
 * without a marker: the model must see that it was not shown everything.
 *
 * @module dsh-node-client/bash
 */
import { spawn } from 'node:child_process'

import { killTree, sandboxSupported, shellArgv } from './shell.mjs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { t } from './i18n.mjs'

const MAX_OUTPUT = 48 * 1024

function clip (text) {
  if (text.length <= MAX_OUTPUT) return text
  return text.slice(0, MAX_OUTPUT) + t('bash.clipped', { shown: MAX_OUTPUT, total: text.length })
}

/**
 * Execute a command.
 * @param {object} options
 * @param {string} options.command command line
 * @param {string} [options.cwd]
 * @param {number} [options.timeout] seconds (comes from the server)
 * @param {string} [options.shell]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, results?: object[], code?: string, message?: string}>}
 */
export function runBash ({ command, cwd, timeout, shell = '/bin/sh', env, stdin, signal, sandbox = null, onSpawn }) {
  return new Promise((resolve) => {
    if (typeof command !== 'string' || !command.trim()) {
      resolve({ ok: false, code: 'bad_args', message: t('bash.needCommand') })
      return
    }
    const seconds = Number(timeout) > 0 ? Number(timeout) : 60
    // Sandbox: argv is wrapped in bwrap, the directory is passed via --chdir.
    // No isolation while a mode was requested — the command does not run at all.
    let argv = [shell, '-c', command]
    let enforcement = 'none'
    if (sandbox && sandbox.mode !== 'full' && !sandboxSupported) {
      // honestly: there is no equivalent of bwrap on this platform, and pretending
      // that the command is isolated is more dangerous than refusing
      return Promise.resolve({
        ok: false,
        code: 'sandbox_unavailable',
        message: `на платформе ${process.platform} песочницы нет: разрешён только режим full`,
      })
    }
    if (sandbox && sandbox.mode !== 'full') {
      const probeResult = sandbox.probe?.() ?? { available: true }
      if (!probeResult.available) {
        return Promise.resolve({
          ok: false,
          code: 'sandbox_unavailable',
          message: probeResult.reason ?? 'bwrap недоступен',
          results: null,
        })
      }
      argv = ['bwrap', ...sandbox.args, '--', shell, '-c', command]
      enforcement = 'bwrap'
    }
    // Windows: its own process group and detached mean something else there, so the
    // platform differences are gathered in lib/shell.mjs
    const windows = process.platform === 'win32'
    const child = spawn(argv[0], argv.slice(1), {
      cwd: sandbox && sandbox.mode !== 'full' ? undefined : (cwd || process.cwd()),
      // LC_ALL=C is mandatory: a kernel refusal arrives localized, and the
      // "read-only file system" signature would not match on a Russian locale
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...env },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // its own process group: otherwise on a timeout only `sh -c` is killed, while
      // the grandchildren (`bash -c 'long &'`) keep running on the machine
      detached: !windows,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const killGroup = () => {
      // on POSIX — the whole group, on Windows — the tree via taskkill
      killTree(child, 'SIGKILL')
    }
    // outward — only the ability to kill: the plugin does not need the process, but a
    // cancel by command number needs exactly that
    onSpawn?.({ kill: killGroup })
    const timer = setTimeout(() => {
      killGroup()
      finish({
        ok: false,
        code: 'timeout',
        message: t('bash.timeout', { seconds }),
      })
    }, seconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()

    if (stdin !== undefined) {
      // we close stdin at once: a command that waits for input must not hang
      child.stdin.on('error', () => {})
      child.stdin.end(typeof stdin === 'string' ? stdin : String(stdin))
    }
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT * 2) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT * 2) stderr += chunk })
    child.on('error', (error) => finish({ ok: false, code: 'internal', message: error.message }))
    child.on('close', (code, signalName) => {
      const content = []
      if (stdout) content.push({ type: 'text', text: clip(stdout) })
      // we mark stderr: otherwise the model sees two identical text blocks
      if (stderr) content.push({ type: 'text', text: '[stderr] ' + clip(stderr) })
      const report = { code, signal: signalName ?? null, cwd: cwd || process.cwd() }
      if (sandbox) {
        // what exactly was applied and whether there was a kernel refusal: without it
        // the model sees an ordinary command error and does not understand that the
        // sandbox is the point
        const verdict = sandbox.classify
          ? sandbox.classify({ code, stderr, mode: sandbox.mode, enforcement })
          : { denied: false, signature: null, runnerFailure: false }
        report.sandbox = {
          mode: sandbox.mode,
          enforcement,
          denied: verdict.denied,
          failed: verdict.failed ?? Number(code) !== 0,
          signature: verdict.signature,
          runnerFailure: verdict.runnerFailure,
        }
      }
      content.push({ type: 'text', text: JSON.stringify(report) })
      finish({ ok: true, results: content })
    })

    signal?.addEventListener?.('abort', () => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'cancelled', message: t('bash.cancelled') })
    }, { once: true })
  })
}

/**
 * Session directory: `$workdir/<session-id>`, created at the first command.
 *
 * The session identifier comes from the server and does not have to be safe as a
 * directory name, so everything except letters, digits, dot, dash and underscore is
 * replaced with "_". An empty session means "we work in workdir itself".
 *
 * @param {object} options
 * @param {string} options.workdir root of the working directories
 * @param {string} [options.session] session identifier
 * @returns {string} path of the session directory
 */
export function sessionDir ({ workdir, session }) {
  const root = String(workdir)
  if (!session) return root
  const safe = String(session).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  // "." and ".." pass the character filter, but they mean the directory itself and
  // its parent: with them the command leaves workdir
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`недопустимый идентификатор сессии: ${JSON.stringify(session)}`)
  }
  const dir = join(root, safe)
  mkdirSync(dir, { recursive: true })
  return dir
}
