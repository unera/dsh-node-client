/**
 * Исполнитель одной команды: bash.
 *
 * Результат — блоки `content` в форме MCP (`text`), как их ждёт сервер
 * (план §4.5). Крупный вывод не режем посередине строки без пометки: модель
 * должна видеть, что ей показали не всё.
 *
 * @module dsh-node-client/bash
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { t } from './i18n.mjs'

const MAX_OUTPUT = 48 * 1024

function clip (text) {
  if (text.length <= MAX_OUTPUT) return text
  return text.slice(0, MAX_OUTPUT) + t('bash.clipped', { shown: MAX_OUTPUT, total: text.length })
}

/**
 * Выполнить команду.
 * @param {object} options
 * @param {string} options.command командная строка
 * @param {string} [options.cwd]
 * @param {number} [options.timeout] секунды (приходит от сервера)
 * @param {string} [options.shell]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: boolean, results?: object[], code?: string, message?: string}>}
 */
export function runBash ({ command, cwd, timeout, shell = '/bin/sh', env, stdin, signal, sandbox = null }) {
  return new Promise((resolve) => {
    if (typeof command !== 'string' || !command.trim()) {
      resolve({ ok: false, code: 'bad_args', message: t('bash.needCommand') })
      return
    }
    const seconds = Number(timeout) > 0 ? Number(timeout) : 60
    // Песочница: argv оборачивается в bwrap, каталог передаётся через --chdir.
    // Нет изоляции при запрошенном режиме — команда не запускается вообще.
    let argv = [shell, '-c', command]
    let enforcement = 'none'
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
    const child = spawn(argv[0], argv.slice(1), {
      cwd: sandbox && sandbox.mode !== 'full' ? undefined : (cwd || process.cwd()),
      // LC_ALL=C обязателен: отказ ядра приходит локализованным, и сигнатура
      // «read-only file system» на русской локали не совпала бы
      env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...env },
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      // своя группа процессов: иначе по таймауту убивается только `sh -c`,
      // а внуки (`bash -c 'long &'`) продолжают работать на машине
      detached: true,
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
      try {
        // минус перед pid — вся группа; без этого внуки выживают
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
    }
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
      // stdin закрываем сразу: команда, которая ждёт ввода, не должна висеть
      child.stdin.on('error', () => {})
      child.stdin.end(typeof stdin === 'string' ? stdin : String(stdin))
    }
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT * 2) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT * 2) stderr += chunk })
    child.on('error', (error) => finish({ ok: false, code: 'internal', message: error.message }))
    child.on('close', (code, signalName) => {
      const content = []
      if (stdout) content.push({ type: 'text', text: clip(stdout) })
      // stderr помечаем: иначе модель видит два одинаковых текстовых блока
      if (stderr) content.push({ type: 'text', text: '[stderr] ' + clip(stderr) })
      const report = { code, signal: signalName ?? null, cwd: cwd || process.cwd() }
      if (sandbox) {
        // что именно применили и был ли отказ ядра: без этого модель видит
        // обычную ошибку команды и не понимает, что дело в песочнице
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
 * Каталог сессии: `$workdir/<session-id>`, создаётся при первой команде.
 *
 * Идентификатор сессии приходит от сервера и не обязан быть безопасным для
 * имени каталога, поэтому всё, кроме букв, цифр, точки, дефиса и подчёркивания,
 * заменяется на «_». Пустая сессия означает «работаем в самом workdir».
 *
 * @param {object} options
 * @param {string} options.workdir корень рабочих каталогов
 * @param {string} [options.session] идентификатор сессии
 * @returns {string} путь каталога сессии
 */
export function sessionDir ({ workdir, session }) {
  const root = String(workdir)
  if (!session) return root
  const safe = String(session).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  // «.» и «..» проходят фильтр символов, но означают сам каталог и его родителя:
  // с ними команда уезжает за пределы workdir
  if (!safe || safe === '.' || safe === '..') {
    throw new Error(`недопустимый идентификатор сессии: ${JSON.stringify(session)}`)
  }
  const dir = join(root, safe)
  mkdirSync(dir, { recursive: true })
  return dir
}
