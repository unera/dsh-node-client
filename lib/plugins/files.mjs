/**
 * The `files` plugin: reading and writing files on the node without starting a
 * shell.
 *
 * The whole point is precisely that this is not `shell`: the path is checked
 * against the allowed directories before any disk access, the operation is atomic,
 * and writing and editing require a file version — if the file changed between
 * reading and writing, the edit does not go through silently. `dsh-fs` in DSH is
 * built the same way: the service states what may be done with a file, and never
 * how exactly it does it.
 *
 * @module dsh-node-client/plugins/files
 */
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { assertInside, canonicalPath } from '../sessions.mjs'
import { t } from '../i18n.mjs'
import { CLIENT_VERSION } from '../api.mjs'
import { handle as transferHandle } from './transfer.mjs'

/** How many bytes we return per read when no more was asked for. */
const READ_LIMIT = 256 * 1024

export function api () {
  return {
    name: 'files',
    version: CLIENT_VERSION,
    description: t('files.api.description'),
    methods: [
      {
        method: 'read',
        description: t('files.read.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            offset: { type: 'number', description: t('files.arg.offset') },
            limit: { type: 'number', description: t('files.arg.limit') },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'write',
        description: t('files.write.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
            ifVersion: { type: 'string', description: t('files.arg.version') },
            createDirs: { type: 'boolean', description: t('files.arg.dirs') },
          },
          required: ['path', 'content'],
          additionalProperties: false,
        },
      },
      {
        method: 'edit',
        description: t('files.edit.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old: { type: 'string' },
            new: { type: 'string' },
            replaceAll: { type: 'boolean' },
            ifVersion: { type: 'string', description: t('files.arg.version') },
          },
          required: ['path', 'old', 'new'],
          additionalProperties: false,
        },
      },
      {
        method: 'sha256',
        description: t('files.sha256.description'),
        args: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'mkdir',
        description: t('files.mkdir.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            name: { type: 'string', description: t('files.arg.name') },
            mode: { type: 'string', description: t('files.arg.mode') },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'copyToDevice',
        description: t('files.copyToDevice.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string', description: t('files.arg.nodePath') },
            hostPath: { type: 'string', description: t('files.arg.hostPath') },
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
            path: { type: 'string', description: t('files.arg.nodePath') },
            hostPath: { type: 'string', description: t('files.arg.hostPath') },
            mode: { type: 'string' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'list',
        description: t('files.list.description'),
        args: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'stat',
        description: t('files.stat.description'),
        args: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ],
  }
}

/** File version: size and modification time. Cheap, but sufficient protection. */
function versionOf (stat) {
  return `${stat.size}-${Math.round(stat.mtimeMs)}`
}

function fail (code, message) {
  return { ok: false, code, message }
}

function text (payload) {
  return { ok: true, results: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** Allow a path: only inside roots, otherwise refuse before touching the disk. */
function resolve (path, ctx) {
  // only explicitly allowed directories: if nothing is configured — refuse, because
  // "/" here would mean "read whatever you like"
  const roots = ctx.fileRoots ?? ctx.roots ?? []
  if (!roots.length) {
    throw Object.assign(new Error('каталоги не настроены: задай roots или workdir в конфиге узла'), { code: 'path_denied' })
  }
  return assertInside(path, roots)
}

export async function handle (command, ctx = {}) {
  const args = command.args ?? {}
  let target
  try {
    target = resolve(args.path, ctx)
  } catch (error) {
    return fail('path_denied', error.message)
  }

  try {
    switch (command.method) {
      case 'read': {
        const stat = statSync(target)
        if (stat.isDirectory()) return fail('bad_args', `это каталог: ${target} (используй list)`)
        const offset = Math.max(0, Number(args.offset) || 0)
        const limit = Math.max(1, Number(args.limit) || READ_LIMIT)
        const buffer = readFileSync(target)
        const slice = buffer.subarray(offset, offset + limit)
        return text({
          path: target,
          version: versionOf(stat),
          size: buffer.length,
          offset,
          text: slice.toString('utf8'),
          truncated: offset + slice.length < buffer.length,
        })
      }
      case 'write': {
        // the version is checked before writing: otherwise the "edit" would silently
        // overwrite someone else's change
        if (args.ifVersion) {
          let current = null
          try {
            current = versionOf(statSync(target))
          } catch {}
          if (current !== args.ifVersion) {
            return fail('stale', `файл изменился: ожидали версию ${args.ifVersion}, на диске ${current ?? 'нет файла'}`)
          }
        }
        if (args.createDirs !== false) mkdirSync(dirname(target), { recursive: true })
        // take the mode from the existing file: rewriting a config must not silently
        // make it 0600 instead of 0644
        let mode = 0o600
        try {
          mode = statSync(target).mode
        } catch {}
        // atomically: a neighbouring temporary file and rename, so that half a file
        // is never left behind
        const temp = `${target}.dshnc-${process.pid}-${Date.now()}`
        try {
          writeFileSync(temp, args.content, { mode })
          renameSync(temp, target)
        } catch (error) {
          try {
            unlinkSync(temp)
          } catch {}
          throw error
        }
        return text({ path: target, version: versionOf(statSync(target)), bytes: Buffer.byteLength(args.content) })
      }
      case 'edit': {
        const stat = statSync(target)
        const version = versionOf(stat)
        if (args.ifVersion && args.ifVersion !== version) {
          return fail('stale', `файл изменился: ожидали ${args.ifVersion}, на диске ${version}`)
        }
        const original = readFileSync(target, 'utf8')
        const occurrences = original.split(args.old).length - 1
        if (!occurrences) return fail('not_found', `строка не найдена в ${target}`)
        if (occurrences > 1 && args.replaceAll !== true) {
          return fail('ambiguous_edit', `строка встречается ${occurrences} раз; уточни или поставь replaceAll`)
        }
        const updated = args.replaceAll === true
          ? original.split(args.old).join(args.new)
          : original.replace(args.old, args.new)
        const temp = `${target}.dshnc-${process.pid}-${Date.now()}`
        writeFileSync(temp, updated, { mode: stat.mode })
        renameSync(temp, target)
        return text({ path: target, version: versionOf(statSync(target)), replaced: args.replaceAll === true ? occurrences : 1 })
      }
      case 'mkdir': {
        // path and name separately: the model often knows the directory and wants to
        // create a subdirectory in it without gluing the string by hand
        const name = args.name ? String(args.name) : null
        const dir = name ? join(target, name) : target
        mkdirSync(dir, { recursive: true })
        if (args.mode) {
          try {
            chmodSync(dir, Number.parseInt(String(args.mode), 8) & 0o777)
          } catch {}
        }
        return text({ path: dir, type: 'dir', created: true })
      }
      case 'copyToDevice':
      case 'copyFromDevice': {
        // the transfer itself is in a separate module: only the method declaration is
        // here, so that the model sees it among the file ones
        return await transferHandle(command, ctx)
      }
      case 'sha256': {
        const hash = createHash('sha256').update(readFileSync(target)).digest('hex')
        return text({ path: target, sha256: hash, size: statSync(target).size })
      }
      case 'list': {
        const stat = statSync(target)
        if (!stat.isDirectory()) return fail('bad_args', `это файл, а не каталог: ${target}`)
        const entries = readdirSync(target, { withFileTypes: true }).map((entry) => {
          const full = join(target, entry.name)
          let size = null
          let mtime = null
          try {
            const info = statSync(full)
            size = info.size
            mtime = Math.round(info.mtimeMs)
          } catch {}
          return { name: entry.name, type: entry.isDirectory() ? 'dir' : 'file', size, mtime }
        })
        return text({ path: target, entries })
      }
      case 'stat': {
        try {
          const info = statSync(target)
          return text({
            path: target,
            exists: true,
            type: info.isDirectory() ? 'dir' : 'file',
            size: info.size,
            mtime: Math.round(info.mtimeMs),
            version: versionOf(info),
          })
        } catch (error) {
          if (error.code === 'EACCES' || error.code === 'EPERM') return fail('path_denied', `нет доступа к ${target}`)
          return text({ path: target, exists: false })
        }
      }
      default:
        return fail('unknown_method', `files: unknown method ${command.method}`)
    }
  } catch (error) {
    if (error.code === 'ENOENT') return fail('not_found', `нет файла ${target}`)
    if (error.code === 'EACCES' || error.code === 'EPERM') return fail('path_denied', `нет доступа к ${target}`)
    return fail('internal', error.message)
  }
}
