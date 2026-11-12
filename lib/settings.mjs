/**
 * The settings file: YAML only, one writer, migration from the old JSON.
 *
 * History: everything used to be in `config.json`. Then tokens and the runtime moved
 * out (`credentials.yaml`, `state.sqlite`), and YAML became canonical because comments
 * can live in it. What was missing was the last step: a node whose `config.json`
 * already existed kept living in JSON forever, and a fresh node got no explanation of
 * its own keys. This module does both: the first open writes a commented template,
 * and an old JSON is moved into YAML once, with the original kept as `config.json.bak`.
 *
 * @module dsh-node-client/settings
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'

import { defaultName, renderSettings } from './template.mjs'

/** What the client has when the human set nothing. */
export const DEFAULT_SETTINGS = { id: null, name: null, aliases: [], workdir: null }

/**
 * The files of the settings layer: the live one, the old one and the backup.
 * @param {string} dir state directory
 */
export function settingsFiles (dir) {
  return {
    yaml: join(dir, 'config.yaml'),
    json: join(dir, 'config.json'),
    backup: join(dir, 'config.json.bak'),
  }
}

/**
 * Read the settings, creating or migrating the file when needed.
 *
 * @param {string} dir state directory
 * @returns {object} settings
 */
export function readSettings (dir) {
  const files = settingsFiles(dir)
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
  const settings = { ...DEFAULT_SETTINGS, ...parsed }

  if (!existsSync(files.yaml)) {
    // first run, or the first run after the upgrade from JSON: the template carries
    // the explanations, the values come from what was there
    const values = { ...settings }
    values.id ??= randomUUID()
    values.name ??= defaultName()
    settings.id = values.id
    settings.name = values.name
    writeFileSync(files.yaml, renderSettings(values, { dir }), { mode: 0o600 })
    // not deleted: someone's old file may hold an edit that did not fit the schema
    if (existsSync(files.json)) renameSync(files.json, files.backup)
  } else if (existsSync(files.json)) {
    // YAML is already the source of truth; JSON would only be rewritten by an old
    // client and quietly win the next read
    renameSync(files.json, files.backup)
  }
  return settings
}

/**
 * Write settings by keys, keeping the comments and everything we did not touch.
 *
 * @param {string} dir state directory
 * @param {object} plain values to write; `undefined` and `servers` are skipped
 * @returns {object} what was written
 */
export function writeSettings (dir, plain) {
  const files = settingsFiles(dir)
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
    if (value === undefined || key === 'servers') continue
    doc.set(key, value)
    written[key] = value
  }
  writeFileSync(files.yaml, String(doc), { mode: 0o600 })
  return written
}
