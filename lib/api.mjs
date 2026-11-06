/**
 * Клиентская часть протокола: заявка, объявление, опрос команд, результат.
 *
 * Ничего не знает про CLI — всё принимает явными параметрами, чтобы это можно
 * было тестировать без процессов и терминала.
 *
 * @module dsh-node-client/api
 */
import { randomUUID } from 'node:crypto'

/** Версия протокола, которую объявляем серверу (`proto`). */
export const PROTO = 1
export const CLIENT_VERSION = `dshnc/0.0.1`

/** Ошибка протокола: HTTP-код + код из закрытого словаря. */
export class NodeError extends Error {
  constructor (status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request (base, path, { method = 'GET', token, body, timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) : {}
    if (!response.ok) {
      if (response.status === 401) throw new NodeError(401, 'unauthorized', 'токен не подошёл')
      throw new NodeError(response.status, payload.code ?? 'bad_request', payload.message ?? `HTTP ${response.status}`)
    }
    return { status: response.status, body: payload }
  } catch (error) {
    if (error instanceof NodeError) throw error
    if (error.name === 'AbortError') throw new NodeError(0, 'timeout', 'сервер не ответил')
    throw new NodeError(0, 'network', error.message)
  } finally {
    clearTimeout(timer)
  }
}

/** Заявка на регистрацию (план §9.1). */
export async function enroll (base, { uuid, name }) {
  return request(base, '/v1/enroll', {
    method: 'POST',
    body: { uuid, name, proto: PROTO, clientVersion: CLIENT_VERSION },
  })
}

/** Опрос заявки: 202 пока ждёт, 200 с токеном после одобрения. */
export async function enrollStatus (base, uuid) {
  try {
    return await request(base, `/v1/enroll/${encodeURIComponent(uuid)}`)
  } catch (error) {
    if (error.status === 202) return { status: 202, body: { status: 'pending' } }
    throw error
  }
}

/**
 * Разобрать ссылку подключения: `.../dsh-nodes/pair?v=<код>`.
 * @param {string} input
 * @returns {{base: string, code: string|null}}
 */
export function parseConnectUrl (input) {
  const url = new URL(input)
  const code = url.searchParams.get('v') ?? url.searchParams.get('code') ?? null
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(pair||enroll)$/, '')
  url.search = ''
  url.hash = ''
  url.pathname = path || '/dsh-nodes'
  return { base: `${url.origin}${url.pathname}`, code }
}

/** Обменять код подключения на токен: подтверждать в админке нечего. */
export async function pair (base, { code, uuid, name }) {
  return request(base, '/v1/pair', {
    method: 'POST',
    body: { code, uuid, name, proto: PROTO, clientVersion: CLIENT_VERSION },
  })
}

/** Объявить, что умеем. */
export async function announce (base, token, apis) {
  return request(base, '/v1/announce', {
    method: 'PUT',
    token,
    body: { apis, proto: PROTO, clientVersion: CLIENT_VERSION },
  })
}

/** Забрать пачку команд строго после курсора. */
export async function commands (base, token, { after = 0, limit = 5 } = {}) {
  return request(base, `/v1/commands?after=${encodeURIComponent(after ?? 0)}&limit=${limit}`, { token })
}

/** Вернуть результат команды. 409 и 404 считаются «уже закрыта». */
export async function result (base, token, seq, payload) {
  try {
    return await request(base, `/v1/commands/${seq}/result`, { method: 'POST', token, body: payload })
  } catch (error) {
    if (error.status === 409 || error.status === 404) return { status: error.status, body: { ok: false, late: true } }
    throw error
  }
}

/** Счётчики узла: нужны для сверки поколения и наличия работы. */
export async function state (base, token) {
  return request(base, '/v1/state', { token })
}

/** API, которое умеет клиент из коробки: одна команда bash. */
export function bashApi ({ shell = '/bin/sh', defaultTimeout = 60 } = {}) {
  return {
    name: 'bash',
    version: '1',
    description: 'Shell на машине узла',
    methods: [
      {
        method: 'exec',
        description: 'Выполнить команду в shell и вернуть stdout, stderr и код возврата',
        args: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Командная строка' },
            cwd: { type: 'string', description: 'Рабочий каталог' },
            timeout: { type: 'number', description: 'Таймаут в секундах' },
          },
          required: ['command'],
          additionalProperties: false,
        },
        meta: { shell, defaultTimeout },
      },
    ],
  }
}

/** Свежий uuid на случай, если в конфиге его нет. */
export function newUuid () {
  return randomUUID()
}
