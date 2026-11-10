/**
 * The client store: three different things in three different places.
 *
 * Everything used to live in a single `config.json`: the human's settings, the tokens
 * and the runtime. The daemon rewrites the runtime after every command, so any edit
 * from the CLI (for instance `dshnc workdir`) was wiped a second later — and the cure
 * for that was a merge on write, that is a patch.
 *
 * Now it is like this:
 *   config.json       — what the human sets: name, aliases, working directory
 *   credentials.yaml  — node tokens (like `.dsh/.credentials.yaml`, mode 0600)
 *   state.sqlite      — runtime: epoch, API numbers; only the daemon writes it
 *
 * Migration from the old format happens when the store is opened, and only once.
 *
 * @module dsh-node-client/store
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'

/** State directory of the client. */
export function home () {
  return process.env.DSHNC_HOME ?? join(homedir(), '.dshnc')
}

function ensureDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** The human's settings. */
export const DEFAULT_SETTINGS = { id: null, name: null, aliases: [], workdir: null }


/**
 * Open the client store.
 * @param {object} [options]
 * @param {string} [options.dir] state directory (`~/.dshnc` by default)
 * @returns {object} the store
 */
export function openStore ({ dir = home() } = {}) {
  ensureDir(dir)
  // YAML is canonical: comments can be written in it, while JSON stays readable —
  // YAML 1.2 is a superset of JSON, so an old config.json opens as is
  const yamlFile = join(dir, 'config.yaml')
  const jsonFile = join(dir, 'config.json')
  const settingsFile = existsSync(yamlFile) || !existsSync(jsonFile) ? yamlFile : jsonFile
  const credentialsFile = join(dir, 'credentials.yaml')
  const stateFile = join(dir, 'state.sqlite')

  const db = new DatabaseSync(stateFile)

  const settings = readSettings()
  let credentials = readCredentials()

  /**
   * Run the schema migrations.
   *
   * Project rule: the `state.sqlite` schema changes only through a migration chain,
   * and the chain runs when the store is opened. The record of what has been applied
   * lives in the database itself, in the `migrations` table: a step is never applied
   * twice, even if the file was opened by an old client and then the new one came
   * back.
   *
   * The runtime (epoch, apiIds) is recoverable: the client announces itself again and
   * the server names its generation in the answer.
   * That is why a migration step is entitled to recreate a table instead of heroically
   * saving the data.
   *
   * @param {DatabaseSync} database
   */
  /**
   * The schema migration chain. Every step has a permanent `id`; the order in the
   * array is the order of application. Steps must not be deleted or renamed — only new
   * ones may be appended at the end.
   */
  const migrations = [
    { id: '0001_init', up: () => {} },
    { id: '0002_split_config', up: () => importLegacySettings() },
    {
      // a session can move to another directory (the `session` plugin), and the choice
      // must survive a daemon restart
      id: '0003_session_workdir',
      up: (database) => database.exec(`CREATE TABLE IF NOT EXISTS session_workdir (
        session TEXT PRIMARY KEY,
        workdir TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
    },
    {
      // commands without a sandbox leave a trace: who, what, when and with what code
      id: '0004_audit',
      up: (database) => database.exec(`CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT,
        mode TEXT NOT NULL,
        command TEXT NOT NULL,
        code INTEGER,
        at INTEGER NOT NULL
      )`),
    },
  ]

  function runMigrations (database) {
    // `cursor` is gone from the protocol: an old file may still carry the column, it
    // is simply left alone (writing never touches it)
    database.exec(`CREATE TABLE IF NOT EXISTS server (
      url TEXT PRIMARY KEY,
      epoch INTEGER,
      boot TEXT,
      node INTEGER,
      alias TEXT,
      api_ids TEXT,
      updated_at INTEGER
    )`)
    database.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    database.exec(`CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`)
    const rows = database.prepare('SELECT id FROM migrations').all()
    const done = new Set(rows.map((row) => row.id))
    for (const migration of migrations) {
      if (done.has(migration.id)) continue
      migration.up(database)
      database.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(migration.id, Date.now())
      database.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', migration.id)
    }
  }

  // ── settings ───────────────────────────────────────────────────────────
  function readSettings () {
    let parsed = {}
    for (const file of [yamlFile, jsonFile]) {
      if (!existsSync(file)) continue
      try {
        parsed = parseYaml(readFileSync(file, 'utf8')) ?? {}
      } catch (error) {
        // a broken config must not silently turn into "default settings": otherwise the
        // client starts with someone else's rules and nobody understands why
        throw new Error(`не смог разобрать ${file}: ${error.message}`)
      }
      break
    }
    return { ...DEFAULT_SETTINGS, ...parsed }
  }

  /**
   * Write the settings into YAML while keeping the human's comments.
   *
   * Rebuilding the file from an object would kill every explanation, so we edit the
   * document by keys. Comments inside a value being changed will not survive — that is
   * unavoidable, and better than losing the whole file.
   */
  function editYaml (file, plain) {
    let doc
    try {
      const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
      doc = parseDocument(raw)
    } catch (error) {
      throw new Error(`не смог разобрать ${file}: ${error.message}`)
    }
    // do not wipe a file that the human wrote with a mistake in it: let them fix it
    // instead of losing the settings together with the comments
    if (doc.errors?.length) throw new Error(`в ${file} ошибка YAML: ${doc.errors[0].message}`)
    for (const [key, value] of Object.entries(plain)) doc.set(key, value)
    return String(doc)
  }

  function saveSettings (patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      settings[key] = value
    }
    // there is no longer a place for tokens and cursors in the config
    const plain = { ...settings }
    delete plain.servers
    const target = existsSync(yamlFile) || !existsSync(jsonFile) ? yamlFile : jsonFile
    const text = target === yamlFile ? editYaml(target, plain) : JSON.stringify(plain, null, 2) + '\n'
    writeFileSync(target, text, { mode: 0o600 })
    return plain
  }

  // ── tokens ─────────────────────────────────────────────────────────────
  function readCredentials () {
    try {
      if (!existsSync(credentialsFile)) return {}
      const parsed = parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
      const out = {}
      // The current format is a list of objects: an editor must not have its eyes
      // broken by url keys. The old format (a url → token map) is read too, otherwise
      // a client update would wipe all the tokens.
      if (Array.isArray(parsed.servers)) {
        for (const entry of parsed.servers) {
          if (typeof entry?.url === 'string' && typeof entry?.token === 'string' && entry.token) {
            out[entry.url] = entry.token
          }
        }
        return out
      }
      for (const [url, token] of Object.entries(parsed)) {
        if (typeof token === 'string' && token) out[url] = token
      }
      return out
    } catch {
      return {}
    }
  }

  function writeCredentials () {
    const existing = (() => {
      try {
        return parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
      } catch {
        return {}
      }
    })()
    const body = stringifyYaml({
      ...(existing.client_nonce ? { client_nonce: existing.client_nonce } : {}),
      servers: Object.entries(credentials).map(([url, token]) => ({ url, token })),
    }, { lineWidth: 0 })
    writeFileSync(credentialsFile, body, { mode: 0o600 })
    try {
      chmodSync(credentialsFile, 0o600)
    } catch {}
  }

  /**
   * The client secret for enrollments: a uuid is not a secret, so a token for an
   * enrollment must be obtainable only by whoever knows this nonce. It lives next to
   * the tokens.
   */
  function clientNonce () {
    try {
      if (!existsSync(credentialsFile)) return ensureClientNonce()
      const parsed = parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
      if (typeof parsed.client_nonce === 'string' && parsed.client_nonce) return parsed.client_nonce
    } catch {}
    return ensureClientNonce()
  }

  function ensureClientNonce () {
    const current = (() => {
      try {
        const parsed = parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
        return typeof parsed.client_nonce === 'string' ? parsed.client_nonce : null
      } catch {
        return null
      }
    })()
    if (current) return current
    const nonce = randomBytes(24).toString('base64url')
    writeCredentials()
    const parsed = (() => {
      try {
        return parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
      } catch {
        return {}
      }
    })()
    parsed.client_nonce = nonce
    writeFileSync(credentialsFile, stringifyYaml(parsed, { lineWidth: 0 }), { mode: 0o600 })
    return nonce
  }

  function token (url) {
    // read the file again: several stores live in one process (the daemon, the code
    // exchange, the CLI), and each has its own snapshot — otherwise a token written by
    // one looks empty to another
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

  // ── runtime ────────────────────────────────────────────────────────────
  function readState (url) {
    const row = db.prepare('SELECT * FROM server WHERE url = ?').get(url)
    if (!row) return { url, epoch: null, boot: null, node: null, alias: null, apiIds: {} }
    let apiIds = {}
    try {
      apiIds = row.api_ids ? JSON.parse(row.api_ids) : {}
    } catch {
      apiIds = {}
    }
    return {
      url,
      epoch: row.epoch,
      boot: row.boot,
      node: row.node,
      alias: row.alias,
      apiIds,
    }
  }

  function writeState (url, patch = {}) {
    const merged = { ...readState(url), ...patch }
    db.prepare(`INSERT INTO server (url, epoch, boot, node, alias, api_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        epoch = excluded.epoch, boot = excluded.boot,
        node = excluded.node, alias = excluded.alias, api_ids = excluded.api_ids,
        updated_at = excluded.updated_at`)
      .run(url, merged.epoch ?? null, merged.boot ?? null,
        merged.node ?? null, merged.alias ?? null, JSON.stringify(merged.apiIds ?? {}), Date.now())
    return merged
  }

  /** The session directory chosen through the `session` plugin. */
  function readSessionDir (session) {
    const row = db.prepare('SELECT workdir FROM session_workdir WHERE session = ?').get(String(session))
    return row?.workdir ?? null
  }

  function writeSessionDir (session, workdir) {
    db.prepare(`INSERT INTO session_workdir (session, workdir, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session) DO UPDATE SET workdir = excluded.workdir, updated_at = excluded.updated_at`)
      .run(String(session), String(workdir), Date.now())
    return workdir
  }

  /**
   * Record a command that was executed without a sandbox.
   *
   * This is not protection but a trace: in `full` mode the client executes anything,
   * and the only thing that can be done is to leave a record, so that later it is
   * visible what exactly was executed.
   */
  function writeAudit ({ session, mode, command, code, at = Date.now() }) {
    db.prepare('INSERT INTO audit (session, mode, command, code, at) VALUES (?, ?, ?, ?, ?)')
      .run(session ?? null, String(mode), String(command).slice(0, 4000), code ?? null, at)
    // keep a ring: a node lives for months, the audit must not eat the disk
    trimAudit({})
    return true
  }

  /** The audit ring: the database on a node must not grow for years. */
  function trimAudit ({ maxRows = 2000, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    if (maxAgeMs > 0) db.prepare('DELETE FROM audit WHERE at < ?').run(Date.now() - maxAgeMs)
    if (maxRows > 0) {
      db.prepare(`DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT ?)`).run(maxRows)
    }
  }

  /** The latest audit records, freshest first. */
  function readAudit (limit = 20) {
    return db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(Number(limit) || 20)
  }

  /** All known servers: from the tokens and from the runtime. */
  function servers () {
    const fresh = readCredentials()
    const set = new Set([...Object.keys(fresh), ...db.prepare('SELECT url FROM server').all().map((row) => row.url)])
    return [...set]
  }

  /** Forget a server completely: the token and the runtime. */
  function forget (url) {
    delete credentials[url]
    writeCredentials()
    db.prepare('DELETE FROM server WHERE url = ?').run(url)
  }

  /**
   * Import the old config.json (servers → tokens + runtime).
   *
   * This is the `0002_split_config` migration step: the record of what has been applied
   * lives in the `migrations` table, so nothing happens twice.
   */
  function importLegacySettings () {
    const legacy = settings.servers ?? {}
    for (const [url, entry] of Object.entries(legacy)) {
      if (entry?.token) credentials[url] = entry.token
      writeState(url, {
        epoch: entry?.epoch ?? null,
        boot: entry?.boot ?? null,
        node: entry?.node ?? null,
        alias: entry?.alias ?? null,
        apiIds: entry?.apiIds ?? {},
      })
    }
    if (Object.keys(legacy).length) writeCredentials()
    // We rewrite the file only if something was really moved: otherwise the migration
    // eats the comments in the config although it was not going to change anything there
    if (!Object.keys(legacy).length) return
    delete settings.servers
    // we write in the same format as everything else: if the config is YAML — YAML
    const target = settingsFile
    const text = target.endsWith('.yaml')
      ? stringifyYaml(settings, { lineWidth: 0 })
      : JSON.stringify(settings, null, 2) + '\n'
    writeFileSync(target, text, { mode: 0o600 })
  }

  // the migration chain — once all the steps and closures are defined
  runMigrations(db)

  return {
    dir,
    files: { settings: settingsFile, credentials: credentialsFile, state: stateFile },
    get settings () {
      return settings
    },
    saveSettings,
    token,
    setToken,
    clientNonce,
    readState,
    writeState,
    /**
     * Persistent counter of the connection: it grows before every connection and lives
     * on disk. The protocol calls it `client_epoch`.
     *
     * The server uses it to decide which connection to keep when the client came up
     * twice, and answers `client-epoch-stale` to an old one. Without it, "who arrived
     * last" is decided by packet ordering, and the connections knock each other out.
     */
    nextClientEpoch (url) {
      const key = `client_epoch:${url}`
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
      // an old file kept the counter under `conn:` — we continue that numbering instead
      // of starting from one, otherwise the first connection after the upgrade looks
      // stale to a server that already knows a bigger number
      const legacy = row ? null : db.prepare('SELECT value FROM meta WHERE key = ?').get(`conn:${url}`)
      const value = Number(row?.value ?? legacy?.value ?? 0) + 1
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value))
      return value
    },
    readSessionDir,
    writeSessionDir,
    writeAudit,
    readAudit,
    trimAudit,
    servers,
    forget,
    close () {
      try {
        db.close()
      } catch {}
    },
  }
}

/** Rewrite a file atomically (used from outside for rare cases). */
export function atomicWrite (file, text, mode = 0o600) {
  const temp = `${file}.tmp`
  writeFileSync(temp, text, { mode })
  renameSync(temp, file)
}
