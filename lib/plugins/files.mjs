/**
 * Плагин `files`: чтение и запись файлов на узле без запуска оболочки.
 *
 * Смысл именно в том, что это не `shell`: путь проверяется по разрешённым
 * каталогам до любого обращения к диску, операция атомарна, а запись и правка
 * требуют версии файла — если файл изменился между чтением и записью, правка
 * не пройдёт молча. Так же устроен `dsh-fs` в DSH: сервис называет, что можно
 * сделать с файлом, и никогда — как именно он это делает.
 *
 * @module dsh-node-client/plugins/files
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { assertInside, canonicalPath } from '../sessions.mjs'
import { t } from '../i18n.mjs'

/** Сколько байт отдаём за одно чтение, если не просили больше. */
const READ_LIMIT = 256 * 1024

export function api () {
  return {
    name: 'files',
    version: '1',
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

/** Версия файла: размер и время правки. Дешёвая, но достаточная защита. */
function versionOf (stat) {
  return `${stat.size}-${Math.round(stat.mtimeMs)}`
}

function fail (code, message) {
  return { ok: false, code, message }
}

function text (payload) {
  return { ok: true, results: [{ type: 'text', text: JSON.stringify(payload) }] }
}

/** Разрешить путь: только внутри roots, иначе отказ до чтения диска. */
function resolve (path, ctx) {
  // только явно разрешённые каталоги: если ничего не настроено — отказ, потому
  // что «/» в этом месте означал бы «читай что хочешь»
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
        // версия проверяется до записи: иначе «правка» молча затрёт чужую
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
        // режим берём у существующего файла: перезапись конфига не должна
        // молча делать его 0600 вместо 0644
        let mode = 0o600
        try {
          mode = statSync(target).mode
        } catch {}
        // атомарно: соседний временный файл и rename, чтобы не оставить половину
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
