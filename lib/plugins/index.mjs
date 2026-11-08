/**
 * Загрузка плагинов клиента.
 *
 * Два источника, одинаковый контракт:
 *   1. встроенные — `lib/plugins/*.mjs` в составе пакета (`bash` первый);
 *   2. пользовательские — `~/.dshnc/plugins/<имя>/index.mjs`.
 *
 * Пользовательский плагин — это файл, который экспортирует `api` и `handle`
 * (или `default` с этими полями). Ошибка в одном плагине не должна уносить
 * остальные: он просто выпадает с предупреждением в лог.
 *
 * @module dsh-node-client/plugins
 */
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { t } from '../i18n.mjs'
import * as filesPlugin from './files.mjs'
import * as jobPlugin from './job.mjs'
import * as sessionPlugin from './session.mjs'
import * as shellPlugin from './shell.mjs'
import * as transferPlugin from './transfer.mjs'

// `session` — внутренний плагин: он не инструмент, а реконфиг сессии,
// поэтому едет рядом с bash и всегда первым (bash тоже должен его видеть)
// `shell` — исполнение команд, `job` — фоновые процессы, `session` — состояние сессии.
// Старое имя `bash` больше не объявляем: два одинаковых API путали и модель, и
// админку. Старые клиенты объявляют его сами, сервер к этому готов.
const BUILTIN = [shellPlugin, jobPlugin, filesPlugin, transferPlugin, sessionPlugin]

/** Проверить, что модуль похож на плагин. */
function asPlugin (module, label) {
  const candidate = module?.api ? module : module?.default
  if (candidate && typeof candidate.api === 'function') {
    const factory = candidate.api
    return asPlugin({ ...candidate, api: factory() }, label)
  }
  if (!candidate?.api?.name) throw new Error(t('plugins.noName', { label }))
  if (typeof candidate.api.name !== 'string') throw new Error(t('plugins.nameType', { label }))
  if (!Array.isArray(candidate.api.methods) || !candidate.api.methods.length) {
    throw new Error(t('plugins.noMethods', { label }))
  }
  if (typeof candidate.handle !== 'function') throw new Error(t('plugins.noHandle', { label }))
  for (const method of candidate.api.methods) {
    if (typeof method?.method !== 'string') throw new Error(t('plugins.methodNoName', { label }))
    if (!method.args || typeof method.args !== 'object') throw new Error(t('plugins.methodNoArgs', { label, method: method.method }))
  }
  return { api: candidate.api, handle: candidate.handle, builtin: true, label }
}

/**
 * Загрузить плагины.
 * @param {object} options
 * @param {string} options.dir каталог пользовательских плагинов
 * @param {(level: string, message: string) => void} [options.log]
 * @returns {Promise<Array<{api: object, handle: Function}>>}
 */
export async function loadPlugins ({ dir, log = () => {} }) {
  const plugins = []
  const seen = new Set()

  for (const module of BUILTIN) {
    const plugin = asPlugin(module, 'builtin')
    plugin.label = `builtin ${plugin.api.name}`
    plugins.push(plugin)
    seen.add(plugin.api.name)
  }

  mkdirSync(dir, { recursive: true })
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch (error) {
    log('warn', t('plugins.directory', { message: error.message }))
  }

  for (const entry of entries.sort()) {
    const full = join(dir, entry)
    const file = statSync(full).isDirectory() ? join(full, 'index.mjs') : full
    if (!file.endsWith('.mjs') || !existsSync(file)) continue
    try {
      const module = await import(pathToFileURL(file).href)
      const plugin = asPlugin(module, entry)
      if (seen.has(plugin.api.name)) {
        log('warn', t('plugins.taken', { entry, name: plugin.api.name }))
        continue
      }
      plugin.builtin = false
      plugin.label = `plugin ${entry}`
      plugins.push(plugin)
      seen.add(plugin.api.name)
    } catch (error) {
      log('warn', t('plugins.failed', { entry, message: error.message }))
    }
  }

  return plugins
}

/** Список API для `/announce`. */
export function apisOf (plugins) {
  return plugins.map((plugin) => plugin.api)
}

/**
 * Найти плагин для команды. Сначала по номеру API, который выдал сервер,
 * потом — по имени метода (сервер мог перезапуститься и нумерация сменилась).
 */
export function resolvePlugin (plugins, command, apiIds = {}) {
  const byId = Object.entries(apiIds).find(([, id]) => id === command.api)
  if (byId) {
    const found = plugins.find((plugin) => plugin.api.name === byId[0])
    if (found) return found
  }
  return plugins.find((plugin) => plugin.api.methods.some((method) => method.method === command.method)) ?? null
}
