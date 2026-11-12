/**
 * dsh-nodes client: state in ~/.dshnc, one server per config.
 *
 * The settings themselves live in YAML and have exactly one writer — lib/settings.mjs.
 * This module only keeps the old `loadConfig`/`saveConfig` names for the commands and
 * the tests that still call them, fills the defaults and normalises server URLs.
 *
 * @module dsh-node-client/config
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { readSettings, writeSettings } from './settings.mjs'

/** State directory. `DSHNC_HOME` overrides it (handy in tests). */
export function home () {
  return process.env.DSHNC_HOME ?? join(homedir(), '.dshnc')
}

function ensureDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/**
 * The settings with the defaults filled in.
 *
 * The config is flat: the address of the single server and the access rules sit side
 * by side, because there is nothing to repeat them for.
 */
export function loadConfig ({ configPath = null } = {}) {
  const dir = home()
  ensureDir(dir)
  const config = readSettings(dir, configPath)
  config.aliases ??= []
  config.workdir ??= null
  // where session directories may be placed; by default only workdir itself
  config.roots ??= null
  // the access cap the node owner sets and the mode a command starts in
  config.max ??= 'rw'
  config.base ??= 'rw'
  // who answers "allow wider": local, server or nobody
  config.approver ??= 'none'
  return config
}

/**
 * Write the settings.
 *
 * `null` means "not set" and must not wipe what is already on disk: the daemon may
 * still hold `null` in memory while the human has already set the value.
 */
export function saveConfig (config, { configPath = null } = {}) {
  const { servers, policy, ...rest } = config ?? {}
  const plain = {}
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === undefined) continue
    plain[key] = value
  }
  return writeSettings(home(), plain, configPath)
}

/** Normalize the URL: no trailing slash and with the dsh-nodes base path. */
export function normalizeUrl (input) {
  const url = new URL(input)
  url.hash = ''
  url.search = ''
  let path = url.pathname.replace(/\/+$/, '')
  if (!path) path = '/dsh-nodes'
  return `${url.origin}${path}`
}
