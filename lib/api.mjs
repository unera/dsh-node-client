/**
 * The client side of the protocol: enrollment, announcement, polling for commands,
 * result.
 *
 * Knows nothing about the CLI — everything arrives as explicit parameters, so that
 * it can be tested without processes and a terminal.
 *
 * @module dsh-node-client/api
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { t } from './i18n.mjs'

// The version comes from package.json: a hardcoded string lied in the admin UI
// (every node showed up as 0.0.1, however often the client was updated).
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
// the platform the client runs on: the server shows it in the panel, and the version
// line carries the same prefix (desktop-x.y.z) so the two cannot be confused
export const PLATFORM = 'desktop'
export const CLIENT_VERSION = `${PLATFORM}-${pkg.version}`
/** The bare client version: `dshnc version` and the line in the log when the daemon starts. */
export const VERSION = pkg.version

/** Protocol error: an HTTP code plus a code from the closed vocabulary. */
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
  // We do not wait for the daemon stop until the end of the request: otherwise
  // `systemctl stop` hangs until the request timeout (30 s), and a test until its own
  // limit
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
    // A proxy or a crashed server may answer with HTML: then this is "not our answer",
    // and what must be discussed is HTTP, not the first characters of the page
    let payload = {}
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        // we do not pass the status through as "unauthorized": an HTML page from a
        // proxy with code 401 must not wipe the node token (review, major)
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

/** Enrollment request (plan §9.1). */
export async function enroll (base, { uuid, name, aliases, nonce }) {
  return request(base, '/v1/enroll', {
    method: 'POST',
    body: { uuid, name, aliases, nonce: nonce ?? null, clientVersion: CLIENT_VERSION, platform: PLATFORM },
  })
}

/** Poll the enrollment: 202 while waiting, 200 with a token after approval. */
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
 * Parse the connection link: `.../dsh-nodes/pair?v=<code>`.
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

/** Exchange the connection code for a token: there is nothing to confirm in the admin UI. */
export async function pair (base, { code, uuid, name, aliases }) {
  return request(base, '/v1/pair', {
    method: 'POST',
    body: { code, uuid, name, aliases, clientVersion: CLIENT_VERSION, platform: PLATFORM },
  })
}

/**
 * Device event: put a record into the session and wake the turn.
 *
 * The enrichment (device name, time) is the server's job: the client must not speak
 * for the human, it reports only "a button was pressed" and the text.
 */
export async function sendEvent (base, token, payload) {
  return request(base, '/v1/events', { method: 'POST', token, body: payload })
}

/**
 * Announce what we can do.
 *
 * `epoch` is the generation we know or `null` if we know none: `null` is how the
 * client says "I restarted, everything issued to me died" — closing those commands is
 * the server's job, the client has no cursor to repair any more.
 * `clientEpoch` (`client_epoch` on the wire) is the persistent connection counter.
 */
export async function announce (base, token, apis, { epoch = null, clientEpoch = null, workdir = null, access = null, allowEscalation = true, uptimeSeconds = null, approver = null, startMode = null, applyRules = null } = {}) {
  return request(base, '/v1/announce', {
    method: 'PUT',
    token,
    // the access cap and "may we ask" are needed by the server to decide whether to
    // put a question to the human when the sandbox refuses
    // the rules travel as a separate list: they have no place in apidef, otherwise
    // the API announcement would have to be edited for server needs
    body: {
      apis,
      applyRules,
      epoch: epoch ?? null,
      client_epoch: clientEpoch ?? null,
      clientVersion: CLIENT_VERSION,
      platform: PLATFORM,
      uptimeSeconds,
      workdir,
      access,
      base: startMode,
      allowEscalation,
      approver,
    },
  })
}

/**
 * Take a batch of commands to execute.
 *
 * There is no cursor: the server gives from the head of the queue and immediately
 * marks what was taken as `processing`, never handing it out again. `limit` — how many
 * to take at a time. `epoch` is our idea of the server generation (left out when we
 * know none), `clientEpoch` our connection counter: on a mismatch the server answers
 * `409 epoch-mismatch` or `409 client-epoch-stale` and the caller starts over from the
 * announce.
 */
export async function commands (base, token, { limit = 5, epoch = null, clientEpoch = null, signal } = {}) {
  const query = [`limit=${limit}`]
  if (epoch !== null && epoch !== undefined) query.push(`epoch=${encodeURIComponent(epoch)}`)
  if (clientEpoch !== null && clientEpoch !== undefined) query.push(`client_epoch=${encodeURIComponent(clientEpoch)}`)
  return request(base, `/v1/commands?${query.join('&')}`, { token, signal })
}

/** Codes that mean "your generation or your connection counter is out of date". */
export const GENERATION_CODES = new Set(['epoch-mismatch', 'client-epoch-stale'])

/** Whether the server asks us to start over from the announce. */
export function isGenerationMismatch (error) {
  return GENERATION_CODES.has(error?.code)
}

/**
 * Return the result of a command. "Already closed" is 409 only.
 *
 * A 409 that names the generation is not "too late": the result was refused because
 * the whole connection is stale, and the caller has to reset the epoch instead of
 * counting the command as delivered.
 */
export async function result (base, token, seq, payload) {
  try {
    return await request(base, `/v1/commands/${seq}/result`, { method: 'POST', token, body: payload })
  } catch (error) {
    // 404 is not "already closed" but "there is no such route": swallowing it means
    // silently losing the result
    if (error.status === 409 && !isGenerationMismatch(error)) return { status: 409, body: { ok: false, late: true } }
    throw error
  }
}

/** The API the client supports out of the box: one bash command. */
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

/** A fresh uuid in case the config does not have one. */
export function newUuid () {
  return randomUUID()
}
