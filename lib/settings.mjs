/**
 * The settings file: YAML only, one writer, migrations from the old shapes.
 *
 * History: everything used to be in `config.json`, and the access rules used to be a
 * per-server map (`policy: {url: {…}}`) because one client could serve several
 * servers at once. Neither is true any more: a client serves exactly one server, so
 * the rules sit at the top level and the address is a single key. A second node is a
 * second config (`dshnc -c <file>`); the tokens stay in one shared
 * `credentials.yaml`, because they are keyed by address.
 *
 * What this module does on open:
 *   - `policy: {url: {…}}` is flattened into `server` + top-level rules (once);
 *   - an old `config.json` becomes `config.yaml` from the commented template, the
 *     original staying as `config.json.bak`;
 *   - a node with no `server` that has exactly one token adopts that address.
 *
 * @module dsh-node-client/settings
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'

import { defaultName, renderSettings } from './template.mjs'

/** What the client has when the human set nothing. */
export const DEFAULT_SETTINGS = { id: null, name: null, aliases: [], workdir: null, server: null }

/** The keys that used to live inside `policy[url]` and now sit at the top level. */
const POLICY_KEYS = ['max', 'base', 'approver', 'ask', 'roots', 'workdir', 'approvalTtlSeconds', 'maxConcurrent']

/**
 * The files of the settings layer: the live one, the old one and the backup.
 * @param {string} dir state directory
 * @param {string} [settingsFile] the config named by `-c`
 */
export function settingsFiles (dir, settingsFile = null) {
  return {
    yaml: settingsFile ?? join(dir, 'config.yaml'),
    json: join(dir, 'config.json'),
    backup: join(dir, 'config.json.bak'),
  }
}

/**
 * Flatten the per-server rules of an old config.
 *
 * The map was keyed by server address and every client served as many servers as it
 * had been given. Now there is one: the first address wins (or the one the config
 * already names), and its rules become the top-level keys.
 *
 * @param {object} parsed settings as they were read
 * @returns {object} flat settings
 */
export function flattenPolicy (parsed) {
  const flat = { ...parsed }
  const policy = flat.policy
  delete flat.policy
  if (!policy || typeof policy !== 'object') return flat
  const urls = Object.keys(policy)
  if (!urls.length) return flat
  const url = flat.server ?? urls[0]
  flat.server ??= url
  const rules = policy[url] ?? policy[urls[0]] ?? {}
  for (const key of POLICY_KEYS) {
    if (flat[key] === undefined && rules[key] !== undefined) flat[key] = rules[key]
  }
  return flat
}

/**
 * Read the settings, creating or migrating the file when needed.
 *
 * @param {string} dir state directory
 * @param {string} [settingsFile] the config named by `-c`
 * @returns {object} settings
 */
export function readSettings (dir, settingsFile = null) {
  const files = settingsFiles(dir, settingsFile)
  const source = existsSync(files.yaml)
    ? files.yaml
    : existsSync(files.json) ? files.json : null
  let parsed = {}
  if (source) {
    try {
      parsed = parseYaml(readFileSync(source, 'utf8')) ?? {}
    } catch (error) {
      // a broken config must not silently turn into "default settings": otherwise the
      // client starts with someone else's rules and nobody understands why
      throw new Error(`не смог разобрать ${source}: ${error.message}`)
    }
  }
  const settings = { ...DEFAULT_SETTINGS, ...flattenPolicy(parsed) }

  if (!existsSync(files.yaml)) {
    // first run, or the first run after the upgrade from JSON: the template carries
    // the explanations, the values come from what was there
    const values = { ...settings }
    values.id ??= randomUUID()
    values.name ??= defaultName()
    settings.id = values.id
    settings.name = values.name
    writeFileSync(files.yaml, renderSettings(values, { dir }), { mode: 0o600 })
    // not deleted: someone's old file may hold an edit that did not fit the schema.
    // A config named by `-c` is not the old default one, so the old default file is
    // somebody else's business and stays where it is
    if (source === files.json && !settingsFile) renameSync(files.json, files.backup)
  } else if (existsSync(files.json) && !settingsFile) {
    // YAML is already the source of truth; JSON would only be rewritten by an old
    // client and quietly win the next read
    renameSync(files.json, files.backup)
  } else {
    // a config written by hand may have no identity yet: a node without an id cannot
    // be paired and cannot be told apart in the admin page, so it gets one
    const missing = {}
    if (!settings.id) missing.id = settings.id = randomUUID()
    if (!settings.name) missing.name = settings.name = defaultName()
    if (Object.keys(missing).length) writeSettings(dir, missing, settingsFile)
  }
  return settings
}

/**
 * Write settings by keys, keeping the comments and everything we did not touch.
 *
 * @param {string} dir state directory
 * @param {object} plain values to write; `undefined`, `servers` and `policy` are skipped
 * @param {string} [settingsFile] the config named by `-c`
 * @returns {object} what was written
 */
export function writeSettings (dir, plain, settingsFile = null) {
  const files = settingsFiles(dir, settingsFile)
  const raw = existsSync(files.yaml)
    ? readFileSync(files.yaml, 'utf8')
    : renderSettings(plain, { dir })
  let doc
  try {
    doc = parseDocument(raw)
  } catch (error) {
    throw new Error(`не смог разобрать ${files.yaml}: ${error.message}`)
  }
  // do not wipe a file that the human wrote with a mistake in it: let them fix it
  // instead of losing the settings together with the comments
  if (doc.errors?.length) throw new Error(`в ${files.yaml} ошибка YAML: ${doc.errors[0].message}`)
  const written = {}
  for (const [key, value] of Object.entries(plain ?? {})) {
    if (value === undefined || key === 'servers' || key === 'policy') continue
    doc.set(key, value)
    written[key] = value
  }
  writeFileSync(files.yaml, String(doc), { mode: 0o600 })
  return written
}
