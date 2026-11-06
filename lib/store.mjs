/**
 * Хранилище клиента: три разных вещи — в трёх разных местах.
 *
 * Раньше всё лежало в одном `config.json`: и настройки человека, и токены, и
 * курсор. Демон сохраняет курсор после каждой команды, поэтому любая правка из
 * CLI (например, `dshnc workdir`) затиралась через секунду — и лечилось это
 * слиянием при записи, то есть заплаткой.
 *
 * Теперь так:
 *   config.json       — то, что задаёт человек: имя, алиасы, рабочая директория
 *   credentials.yaml  — токены узлов (как `.dsh/.credentials.yaml`, режим 0600)
 *   state.sqlite      — рантайм: курсор, epoch, номера API; пишет только демон
 *
 * Миграция из старого формата делается при открытии и только один раз.
 *
 * @module dsh-node-client/store
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/** Каталог состояния клиента. */
export function home () {
  return process.env.DSHNC_HOME ?? join(homedir(), '.dshnc')
}

function ensureDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Настройки человека. */
export const DEFAULT_SETTINGS = { id: null, name: null, aliases: [], workdir: null }

/**
 * Открыть хранилище клиента.
 * @param {object} [options]
 * @param {string} [options.dir] каталог состояния (по умолчанию `~/.dshnc`)
 * @returns {object} хранилище
 */
export function openStore ({ dir = home() } = {}) {
  ensureDir(dir)
  const settingsFile = join(dir, 'config.json')
  const credentialsFile = join(dir, 'credentials.yaml')
  const stateFile = join(dir, 'state.sqlite')

  const db = new DatabaseSync(stateFile)
  db.exec(`CREATE TABLE IF NOT EXISTS server (
    url TEXT PRIMARY KEY,
    cursor INTEGER,
    epoch INTEGER,
    boot TEXT,
    node INTEGER,
    alias TEXT,
    api_ids TEXT,
    updated_at INTEGER
  )`)
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')

  const settings = readSettings()
  let credentials = readCredentials()
  migrate()

  // ── настройки ──────────────────────────────────────────────────────────
  function readSettings () {
    let parsed = {}
    try {
      if (existsSync(settingsFile)) parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) ?? {}
    } catch {
      parsed = {}
    }
    return { ...DEFAULT_SETTINGS, ...parsed }
  }

  function saveSettings (patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      settings[key] = value
    }
    // в config.json больше не место токенам и курсорам
    const plain = { ...settings }
    delete plain.servers
    writeFileSync(settingsFile, JSON.stringify(plain, null, 2) + '\n', { mode: 0o600 })
    return plain
  }

  // ── токены ─────────────────────────────────────────────────────────────
  function readCredentials () {
    try {
      if (!existsSync(credentialsFile)) return {}
      const parsed = parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
      const out = {}
      for (const [url, token] of Object.entries(parsed)) {
        if (typeof token === 'string' && token) out[url] = token
      }
      return out
    } catch {
      return {}
    }
  }

  function writeCredentials () {
    const body = stringifyYaml(credentials, { lineWidth: 0 })
    writeFileSync(credentialsFile, body, { mode: 0o600 })
    try {
      chmodSync(credentialsFile, 0o600)
    } catch {}
  }

  function token (url) {
    // читаем файл заново: в одном процессе живёт несколько хранилищ (демон,
    // обмен кодом, CLI), и у каждого свой снимок — иначе токен, записанный
    // одним, для другого выглядит пустым
    const fresh = readCredentials()
    for (const key of Object.keys(fresh)) credentials[key] = fresh[key]
    return fresh[url] ?? null
  }

  function setToken (url, value) {
    const fresh = readCredentials()
    if (value) fresh[url] = value
    else delete fresh[url]
    credentials = fresh
    writeCredentials()
  }

  // ── рантайм ────────────────────────────────────────────────────────────
  function readState (url) {
    const row = db.prepare('SELECT * FROM server WHERE url = ?').get(url)
    if (!row) return { url, cursor: null, epoch: null, boot: null, node: null, alias: null, apiIds: {} }
    let apiIds = {}
    try {
      apiIds = row.api_ids ? JSON.parse(row.api_ids) : {}
    } catch {
      apiIds = {}
    }
    return {
      url,
      cursor: row.cursor,
      epoch: row.epoch,
      boot: row.boot,
      node: row.node,
      alias: row.alias,
      apiIds,
    }
  }

  function writeState (url, patch = {}) {
    const merged = { ...readState(url), ...patch }
    db.prepare(`INSERT INTO server (url, cursor, epoch, boot, node, alias, api_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        cursor = excluded.cursor, epoch = excluded.epoch, boot = excluded.boot,
        node = excluded.node, alias = excluded.alias, api_ids = excluded.api_ids,
        updated_at = excluded.updated_at`)
      .run(url, merged.cursor ?? null, merged.epoch ?? null, merged.boot ?? null,
        merged.node ?? null, merged.alias ?? null, JSON.stringify(merged.apiIds ?? {}), Date.now())
    return merged
  }

  /** Все известные серверы: из токенов и из рантайма. */
  function servers () {
    const fresh = readCredentials()
    const set = new Set([...Object.keys(fresh), ...db.prepare('SELECT url FROM server').all().map((row) => row.url)])
    return [...set]
  }

  /** Удалить сервер полностью: токен и рантайм. */
  function forget (url) {
    delete credentials[url]
    writeCredentials()
    db.prepare('DELETE FROM server WHERE url = ?').run(url)
  }

  /** Разово перенести старый config.json (servers → токены + рантайм). */
  function migrate () {
    if (db.prepare('SELECT value FROM meta WHERE key = ?').get('migrated')) return
    const legacy = settings.servers ?? {}
    for (const [url, entry] of Object.entries(legacy)) {
      if (entry?.token) credentials[url] = entry.token
      writeState(url, {
        cursor: entry?.cursor ?? null,
        epoch: entry?.epoch ?? null,
        boot: entry?.boot ?? null,
        node: entry?.node ?? null,
        alias: entry?.alias ?? null,
        apiIds: entry?.apiIds ?? {},
      })
    }
    if (Object.keys(legacy).length) writeCredentials()
    delete settings.servers
    writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('migrated', String(Date.now()))
  }

  return {
    dir,
    files: { settings: settingsFile, credentials: credentialsFile, state: stateFile },
    get settings () {
      return settings
    },
    saveSettings,
    token,
    setToken,
    readState,
    writeState,
    servers,
    forget,
    close () {
      try {
        db.close()
      } catch {}
    },
  }
}

/** Атомарно переписать файл (используется снаружи для редких случаев). */
export function atomicWrite (file, text, mode = 0o600) {
  const temp = `${file}.tmp`
  writeFileSync(temp, text, { mode })
  renameSync(temp, file)
}
