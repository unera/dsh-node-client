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

import * as bashPlugin from './bash.mjs'

const BUILTIN = [bashPlugin]

/** Проверить, что модуль похож на плагин. */
function asPlugin (module, label) {
  const candidate = module?.api ? module : module?.default
  if (!candidate?.api?.name) throw new Error(`${label}: нет api.name`)
  if (typeof candidate.api.name !== 'string') throw new Error(`${label}: api.name должен быть строкой`)
  if (!Array.isArray(candidate.api.methods) || !candidate.api.methods.length) {
    throw new Error(`${label}: api.methods пуст`)
  }
  if (typeof candidate.handle !== 'function') throw new Error(`${label}: нет handle()`)
  for (const method of candidate.api.methods) {
    if (typeof method?.method !== 'string') throw new Error(`${label}: метод без имени`)
    if (!method.args || typeof method.args !== 'object') throw new Error(`${label}: метод ${method.method} без схемы args`)
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
    const plugin = asPlugin(module, 'встроенный')
    plugin.label = `встроенный ${plugin.api.name}`
    plugins.push(plugin)
    seen.add(plugin.api.name)
  }

  mkdirSync(dir, { recursive: true })
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch (error) {
    log('warn', `каталог плагинов не читается: ${error.message}`)
  }

  for (const entry of entries.sort()) {
    const full = join(dir, entry)
    const file = statSync(full).isDirectory() ? join(full, 'index.mjs') : full
    if (!file.endsWith('.mjs') || !existsSync(file)) continue
    try {
      const module = await import(pathToFileURL(file).href)
      const plugin = asPlugin(module, entry)
      if (seen.has(plugin.api.name)) {
        log('warn', `плагин ${entry} объявляет api «${plugin.api.name}», который уже занят — пропущен`)
        continue
      }
      plugin.builtin = false
      plugin.label = `плагин ${entry}`
      plugins.push(plugin)
      seen.add(plugin.api.name)
    } catch (error) {
      log('warn', `плагин ${entry} не загрузился: ${error.message}`)
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
