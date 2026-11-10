/**
 * Loading the client's plugins.
 *
 * Two sources, the same contract:
 *   1. built-in — `lib/plugins/*.mjs` shipped with the package (`bash` first);
 *   2. user ones — `~/.dshnc/plugins/<name>/index.mjs`.
 *
 * A user plugin is a file that exports `api` and `handle` (or `default` with those
 * fields). An error in one plugin must not take the others down: it simply drops
 * out with a warning in the log.
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

// `session` is an internal plugin: it is not a tool but a session reconfigure,
// so it travels next to bash and always first (bash must see it too)
// `shell` — command execution, `job` — background processes, `session` — session state.
// The old name `bash` is no longer announced: two identical APIs confused both the
// model and the admin UI. Old clients announce it themselves, the server is ready
// for that.
const BUILTIN = [shellPlugin, jobPlugin, filesPlugin, sessionPlugin]

/** Check that a module looks like a plugin. */
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
  return { api: candidate.api, handle: candidate.handle, handleControl: candidate.handleControl, builtin: true, label }
}

/**
 * Load the plugins.
 * @param {object} options
 * @param {string} options.dir directory of user plugins
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

/** API list for `/announce`. */
export function apisOf (plugins) {
  return plugins.map((plugin) => plugin.api)
}

/**
 * Rule bindings to methods — as a separate list, which is what announce requires.
 *
 * A plugin declares rules next to its API (`rules: [{method, rule, rulesOpts}]`),
 * but they do not make it into the API announcement itself: a rule describes how
 * this machine executes a command, not the API contract.
 *
 * @param {Array<{api: {name: string, rules?: object[]}}>} plugins
 * @returns {Array<{api: string, method: string, rule: string, rulesOpts?: object}>}
 */
export function rulesOf (plugins) {
  const rules = []
  for (const plugin of plugins) {
    for (const entry of plugin.api?.rules ?? []) {
      rules.push({ api: plugin.api.name, ...entry })
    }
  }
  return rules
}

/**
 * Find the plugin for a command. First by the API number the server handed out,
 * then by the method name (the server may have restarted and the numbering
 * changed).
 */
export function resolvePlugin (plugins, command, apiIds = {}) {
  // `#…` are control names: they are not announced in the API, we look them up by ability
  if (String(command.method ?? '').startsWith('#')) {
    return plugins.find((plugin) => typeof plugin.handleControl === 'function') ?? null
  }
  const byId = Object.entries(apiIds).find(([, id]) => id === command.api)
  if (byId) {
    const found = plugins.find((plugin) => plugin.api.name === byId[0])
    if (found) return found
  }
  return plugins.find((plugin) => plugin.api.methods.some((method) => method.method === command.method)) ?? null
}
