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

import { t } from './i18n.mjs'

const MAX_OUTPUT = 48 * 1024

function clip (text) {
  if (text.length <= MAX_OUTPUT) return text
  return text.slice(0, MAX_OUTPUT) + `\n… обрезано: показано ${MAX_OUTPUT} из ${text.length} символов`
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
export function runBash ({ command, cwd, timeout, shell = '/bin/sh', env, signal }) {
  return new Promise((resolve) => {
    if (typeof command !== 'string' || !command.trim()) {
      resolve({ ok: false, code: 'bad_args', message: t('bash.needCommand') })
      return
    }
    const seconds = Number(timeout) > 0 ? Number(timeout) : 60
    const child = spawn(shell, ['-c', command], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        ok: false,
        code: 'timeout',
        message: t('bash.timeout', { seconds }),
      })
    }, seconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()

    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT * 2) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT * 2) stderr += chunk })
    child.on('error', (error) => finish({ ok: false, code: 'internal', message: error.message }))
    child.on('close', (code, signalName) => {
      const content = []
      if (stdout) content.push({ type: 'text', text: clip(stdout) })
      if (stderr) content.push({ type: 'text', text: clip(stderr) })
      content.push({
        type: 'text',
        text: JSON.stringify({ code, signal: signalName ?? null, cwd: cwd || process.cwd() }),
      })
      finish({ ok: true, results: content })
    })

    signal?.addEventListener?.('abort', () => {
      child.kill('SIGKILL')
      finish({ ok: false, code: 'cancelled', message: t('bash.cancelled') })
    }, { once: true })
  })
}
