/**
 * The `transfer` plugin: file transfer between the node and the host in one HTTP
 * request.
 *
 * Previously a file travelled in chunks command by command: a round-trip per
 * megabyte plus base64 (+33% of volume). Here the request body is the bytes
 * themselves, and the permission is given by the command itself: the server issued
 * it, which means the transfer of this file is allowed.
 *
 * @module dsh-node-client/plugins/transfer
 */
import { createHash } from 'node:crypto'
import { chmodSync, createReadStream, createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'

import { assertInside, canonicalPath } from '../sessions.mjs'
import { t } from '../i18n.mjs'

export function api () {
  return {
    name: 'files-transfer',
    version: '1',
    description: 'File transfer between the node and the host in one HTTP request',
    methods: [
      {
        method: 'copyToDevice',
        description: t('files.copyToDevice.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            hostPath: { type: 'string' },
            mode: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'copyFromDevice',
        description: t('files.copyFromDevice.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            hostPath: { type: 'string' },
            mode: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ],
  }
}

/** Where to knock: the same server whose socket we hold. */
function endpoint (ctx, command, route) {
  const server = String(ctx?.server ?? '')
  if (!server) throw Object.assign(new Error('адрес сервера неизвестен: передача невозможна'), { code: 'no_server' })
  // `base` is the address of the nodes protocol together with its prefix, while the
  // admin routes live in the host root under /api; we take only the origin,
  // otherwise the path would be doubled
  // the routes live in the nodes protocol: `/api/*` is closed by DSH authorization,
  // while the node has only a Bearer token
  return new URL(`${server.replace(/\/$/, '')}${route}?seq=${command.seq}`)
}

/** Headers: the node token is the only thing it presents itself with. */
function headers (ctx, extra = {}) {
  return { authorization: `Bearer ${ctx?.token ?? ''}`, ...extra }
}

/** Call the route and return the response as a stream. */
function call (url, method, ctx, extraHeaders, body) {
  const requester = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = requester(url, { method, headers: headers(ctx, extraHeaders) }, (res) => resolve(res))
    req.on('error', reject)
    if (body) {
      body.on('error', (error) => req.destroy(error))
      body.pipe(req)
    } else {
      req.end()
    }
  })
}

/** Refusal body: the server sends a code and text that the model will read. */
async function failure (res) {
  let text = ''
  for await (const chunk of res) text += chunk
  let payload = null
  try {
    payload = JSON.parse(text)
  } catch {}
  const message = payload?.message ?? text.slice(0, 300) ?? ''
  return {
    ok: false,
    code: payload?.code ?? `http_${res.statusCode}`,
    message: `сервер отказал (${res.statusCode}): ${message}`,
  }
}

export async function handle (command, ctx = {}) {
  const args = command.args ?? {}
  let target
  try {
    target = assertInside(canonicalPath(args.path), ctx.fileRoots ?? ctx.roots ?? [])
  } catch (error) {
    return { ok: false, code: 'path_denied', message: error.message }
  }

  if (command.method === 'copyFromDevice') {
    let url
    try {
      url = endpoint(ctx, command, '/v1/upload-file')
    } catch (error) {
      return { ok: false, code: error.code ?? 'no_server', message: error.message }
    }
    let info
    try {
      info = statSync(target)
    } catch {
      return { ok: false, code: 'not_found', message: `файла ${target} нет: отправлять нечего` }
    }
    const hash = createHash('sha256')
    const body = createReadStream(target)
    body.on('data', (chunk) => hash.update(chunk))
    try {
      const res = await call(url, 'POST', ctx, {
        'content-type': 'application/octet-stream',
        'content-length': String(info.size),
        'x-mode': String(args.mode ?? (info.mode & 0o777).toString(8)),
      }, body)
      if (res.statusCode !== 200) return await failure(res)
      for await (const _ of res) void 0
      return { ok: true, results: [{ type: 'text', text: JSON.stringify({ path: target, bytes: info.size, sha256: hash.digest('hex') }) }] }
    } catch (error) {
      return { ok: false, code: 'transfer_failed', message: `передача не удалась: ${error.message}` }
    }
  }

  // download: write to <path>.inprogress and rename after the 200 response
  const part = `${target}.inprogress`
  let url
  try {
    url = endpoint(ctx, command, '/v1/download-file')
  } catch (error) {
    return { ok: false, code: error.code ?? 'no_server', message: error.message }
  }
  mkdirSync(dirname(part), { recursive: true })
  let res
  try {
    res = await call(url, 'POST', ctx, { 'content-length': '0' })
  } catch (error) {
    return { ok: false, code: 'transfer_failed', message: `передача не удалась: ${error.message}` }
  }
  if (res.statusCode !== 200) return await failure(res)

  const hash = createHash('sha256')
  res.on('data', (chunk) => hash.update(chunk))
  try {
    await pipeline(res, createWriteStream(part, { mode: 0o600 }))
  } catch (error) {
    try {
      unlinkSync(part)
    } catch {}
    return { ok: false, code: 'transfer_failed', message: `ответ оборвался: ${error.message}` }
  }
  const expected = res.headers['x-sha256']
  const got = hash.digest('hex')
  if (expected && expected !== got) {
    try {
      unlinkSync(part)
    } catch {}
    return { ok: false, code: 'hash_mismatch', message: `sha256 не совпал: ждали ${expected}, получили ${got}` }
  }
  let mode = args.mode ? Number.parseInt(String(args.mode), 8) & 0o777 : 0o600
  try {
    mode = statSync(target).mode & 0o777
  } catch {}
  chmodSync(part, mode)
  renameSync(part, target)
  return { ok: true, results: [{ type: 'text', text: JSON.stringify({ path: target, bytes: statSync(target).size, sha256: got }) }] }
}
