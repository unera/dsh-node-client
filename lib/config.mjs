/**
 * dsh-nodes client: state in ~/.dshnc, connections by URL.
 *
 * A single client can work with several servers, so everything that belongs to a
 * connection (token, cursor, epoch, reconnect) is stored per URL.
 *
 * @module dsh-node-client/config
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** State directory. `DSHNC_HOME` overrides it (handy in tests). */
export function home () {
  return process.env.DSHNC_HOME ?? join(homedir(), '.dshnc')
}

function ensureDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Config: client id and connection profiles. */
export function loadConfig () {
  const dir = home()
  ensureDir(dir)
  const file = join(dir, 'config.json')
  let config = { id: null, name: null, aliases: [], servers: {} }
  if (existsSync(file)) {
    config = { ...config, ...JSON.parse(readFileSync(file, 'utf8')) }
  }
  if (!config.id) {
    config.id = randomUUID()
    config.name = (process.env.DSHNC_NAME ?? hostname() ?? 'node').slice(0, 64)
    saveConfig(config)
  }
  config.servers ??= {}
  config.aliases ??= []
  config.workdir ??= null
  // where session directories may be placed; by default only workdir itself
  config.roots ??= null
  // the access cap that the node owner sets
  config.access ??= { max: 'rw', ask: true }
  // access rules per server: policy[url] wins over the common fields
  config.policy ??= {}
  return config
}

/**
 * Write the config without wiping other people's changes.
 *
 * The daemon saves the cursor after every command, while the CLI may change the
 * working directory or the aliases at the same time. Writing one's own object
 * wholesale means an edit made by `dshnc workdir` disappears a second later —
 * that is why we read the file and put our keys on top, merging servers by URL.
 */
export function saveConfig (config) {
  const dir = home()
  ensureDir(dir)
  const file = join(dir, 'config.json')
  let onDisk = {}
  try {
    if (existsSync(file)) onDisk = JSON.parse(readFileSync(file, 'utf8')) ?? {}
  } catch {
    onDisk = {}
  }
  // null means "not set" — such a value must not wipe what is already on disk:
  // the daemon may still have null for workdir in memory
  const own = {}
  for (const [key, value] of Object.entries(config)) {
    if (value === null || value === undefined) continue
    own[key] = value
  }
  const merged = { ...onDisk, ...own }
  merged.servers = { ...(onDisk.servers ?? {}) }
  for (const [url, state] of Object.entries(config.servers ?? {})) {
    const clean = {}
    for (const [key, value] of Object.entries(state ?? {})) {
      if (value === null || value === undefined) continue
      clean[key] = value
    }
    merged.servers[url] = { ...(onDisk.servers?.[url] ?? {}), ...clean }
  }
  writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 })
  return merged
}

/** A single server's record: token, cursor, generation epoch. */
export function serverState (config, url) {
  config.servers ??= {}
  config.servers[url] ??= { token: null, cursor: null, epoch: null, boot: null }
  return config.servers[url]
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
