/**
 * Клиентская часть протокола: заявка, объявление, опрос команд, результат.
 *
 * Ничего не знает про CLI — всё принимает явными параметрами, чтобы это можно
 * было тестировать без процессов и терминала.
 *
 * @module dsh-node-client/api
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { t } from './i18n.mjs'

/** Версия протокола, которую объявляем серверу (`proto`). */
export const PROTO = 1
// Версия берётся из package.json: зашитая строка врала в админке (все узлы
// показывались как 0.0.1, сколько бы клиент ни обновляли).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
// префикс платформы: у Android своя линейка версий (android-x.y.z),
// и в одном поле они не должны путаться
export const CLIENT_VERSION = `desktop-${pkg.version}`
/** Голая версия клиента: `dshnc version` и строка в логе при старте демона. */
export const VERSION = pkg.version

/** Ошибка протокола: HTTP-код + код из закрытого словаря. */
export class NodeError extends Error {
  constructor (status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function request (base, path, { method = 'GET', token, body, timeoutMs = 30000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // Остановку демона не ждём до конца запроса: иначе `systemctl stop` висит
  // до таймаута запроса (30 с), а тест — до своего предела
  const onAbort = () => controller.abort()
  signal?.addEventListener?.('abort', onAbort, { once: true })
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
    // Прокси или упавший сервер может ответить HTML: тогда это «не наш ответ»,
    // и говорить надо про HTTP, а не про первые символы страницы
    let payload = {}
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        // статус не пробрасываем как «unauthorized»: HTML-страница прокси с
        // кодом 401 не должна стирать токен узла (ревью, major)
        throw new NodeError(response.status, 'bad_response', t('api.notJson', { status: response.status }))
      }
    }
    if (!response.ok) {
      if (response.status === 401) {
        if (process.env.DSHNC_DEBUG) {
          // eslint-disable-next-line no-console
          console.error(`[debug] 401 ${path} token=${String(token ?? '').slice(0, 8)}…`)
        }
        throw new NodeError(401, 'unauthorized', t('api.unauthorized'))
      }
      throw new NodeError(response.status, payload.code ?? 'bad_request', payload.message ?? t('api.http', { status: response.status }))
    }
    return { status: response.status, body: payload }
  } catch (error) {
    if (error instanceof NodeError) throw error
    if (error.name === 'AbortError') throw new NodeError(0, 'timeout', t('api.timeout'))
    throw new NodeError(0, 'network', error.message)
  } finally {
    clearTimeout(timer)
  }
}

/** Заявка на регистрацию (план §9.1). */
export async function enroll (base, { uuid, name, aliases, nonce }) {
  return request(base, '/v1/enroll', {
    method: 'POST',
    body: { uuid, name, aliases, nonce: nonce ?? null, proto: PROTO, clientVersion: CLIENT_VERSION },
  })
}

/** Опрос заявки: 202 пока ждёт, 200 с токеном после одобрения. */
export async function enrollStatus (base, uuid, nonce = null) {
  try {
    const query = nonce ? `?nonce=${encodeURIComponent(nonce)}` : ''
    return await request(base, `/v1/enroll/${encodeURIComponent(uuid)}${query}`)
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
export async function pair (base, { code, uuid, name, aliases }) {
  return request(base, '/v1/pair', {
    method: 'POST',
    body: { code, uuid, name, aliases, proto: PROTO, clientVersion: CLIENT_VERSION },
  })
}

/**
 * Событие устройства: положить запись в сессию и разбудить ход.
 *
 * Обогащение (имя устройства, время) делает сервер: клиент не должен
 * говорить за человека, он сообщает только «нажата кнопка» и текст.
 */
export async function sendEvent (base, token, payload) {
  return request(base, '/v1/events', { method: 'POST', token, body: payload })
}

/** Объявить, что умеем. */
export async function announce (base, token, apis, { workdir = null, access = null, allowEscalation = true, uptimeSeconds = null, approver = null, startMode = null, applyRules = null } = {}) {
  return request(base, '/v1/announce', {
    method: 'PUT',
    token,
    // потолок прав и «можно ли спрашивать» нужны серверу, чтобы решать,
    // задавать ли вопрос человеку при отказе песочницы
    // правила едут отдельным списком: в apidef им не место, иначе объявление
    // API пришлось бы править под серверные нужды
    body: { apis, applyRules, proto: PROTO, clientVersion: CLIENT_VERSION, workdir, access, allowEscalation, uptimeSeconds, approver, base: startMode },
  })
}

/**
 * Забрать пачку команд на исполнение.
 *
 * Курсора больше нет: сервер отдаёт с головы очереди и сразу помечает взятое
 * как `processing`, повторно не выдаёт. `limit` — сколько взять за раз.
 */
export async function commands (base, token, { limit = 5, signal } = {}) {
  return request(base, `/v1/commands?limit=${limit}`, { token, signal })
}

/** Вернуть результат команды. «Уже закрыта» — только 409. */
export async function result (base, token, seq, payload) {
  try {
    return await request(base, `/v1/commands/${seq}/result`, { method: 'POST', token, body: payload })
  } catch (error) {
    // 404 — это не «уже закрыта», а «такого маршрута нет»: проглотить его значит
    // молча потерять результат и всё равно сдвинуть курсор
    if (error.status === 409) return { status: 409, body: { ok: false, late: true } }
    throw error
  }
}

/** Счётчики узла: нужны для сверки поколения и наличия работы. */
export async function state (base, token, { signal } = {}) {
  return request(base, '/v1/state', { token, signal })
}

/** API, которое умеет клиент из коробки: одна команда bash. */
export function bashApi ({ shell = '/bin/sh', defaultTimeout = 60 } = {}) {
  return {
    name: 'bash',
    version: '2',
    description: t('bash.api.description'),
    methods: [
      {
        method: 'exec',
        description: t('bash.exec.description'),
        args: {
          type: 'object',
          properties: {
            command: { type: 'string', description: t('bash.arg.command') },
            cwd: { type: 'string', description: t('bash.arg.cwd') },
            timeout: { type: 'number', description: t('bash.arg.timeout') },
            stdin: { type: 'string', description: t('bash.arg.stdin') },
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
