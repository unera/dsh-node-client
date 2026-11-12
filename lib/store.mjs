/**
 * The client store: three different things in three different places.
 *
 * Everything used to live in a single `config.json`: the human's settings, the tokens
 * and the runtime. The daemon rewrites the runtime after every command, so any edit
 * from the CLI (for instance `dshnc workdir`) was wiped a second later — and the cure
 * for that was a merge on write, that is a patch.
 *
 * Now it is like this:
 *   config.yaml       — what the human sets: server, name, aliases, rules
 *   credentials.yaml  — the node token (like `.dsh/.credentials.yaml`, mode 0600)
 *   state.sqlite      — runtime: epoch, API numbers; only the daemon writes it
 *
 * One client serves exactly one server: the address is a key of the config, not a
 * section that repeats. A second node is a second state directory, reached with
 * `dshnc -c <file>`; the token and the runtime always live next to their config.
 *
 * The migrations happen when the store is opened, and only once: the old `servers`
 * map goes into the token file, a per-server `policy` map is flattened into the
 * top-level keys, and an old `config.json` becomes `config.yaml` written from the
 * commented template (the original stays as `.bak`).
 *
 * @module dsh-node-client/store
 */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { DEFAULT_SETTINGS, readSettings as readSettingsFile, settingsFiles, writeSettings } from './settings.mjs'
import { renderSettings } from './template.mjs'

/**
 * Where this client keeps its state and which file holds its settings.
 *
 * The state directory is `~/.dshnc` (`DSHNC_HOME` overrides it, which is what the
 * tests use) and it is shared: `credentials.yaml` keeps the tokens of every server
 * the machine knows, `state.sqlite` their runtime. One directory, several configs.
 *
 * `-c/--config <file>` replaces only the settings file: a second node on the same
 * machine is a second YAML, and both use the same token file.
 *
 * @param {object} [options]
 * @param {string} [options.configPath] value of `-c` (defaults to `DSHNC_CONFIG`)
 * @returns {{dir: string, settings: string}}
 */
export function stateFor ({ configPath = null } = {}) {
  const dir = process.env.DSHNC_HOME ?? join(homedir(), '.dshnc')
  // the CLI puts `-c` into the environment, so that every internal `openStore()` — the
  // daemon loop, the plugins, the enrollment — works with the same config without
  // threading the path through half the modules
  const chosen = configPath ?? process.env.DSHNC_CONFIG ?? null
  const settings = chosen ? resolve(chosen) : settingsFiles(dir).yaml
  return { dir, settings }
}

/** State directory of the client. */
export function home () {
  return stateFor().dir
}

function ensureDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

export { DEFAULT_SETTINGS }

/**
 * Open the client store.
 * @param {object} [options]
 * @param {string} [options.dir] state directory (`~/.dshnc` by default)
 * @param {string} [options.configPath] config file (`-c`), its directory becomes the state directory
 * @returns {object} the store
 */
export function openStore ({ dir = null, configPath = null } = {}) {
  const state = stateFor({ configPath })
  const root = ensureDir(dir ?? state.dir)
  // YAML is canonical and is the only file we write: an old config.json is migrated
  // on the first open (see lib/settings.mjs), comments in YAML survive every edit
  const explicitSettings = Boolean(configPath || process.env.DSHNC_CONFIG)
  const settingsFile = explicitSettings ? state.settings : settingsFiles(root).yaml
  const credentialsFile = join(root, 'credentials.yaml')
  const stateFile = join(root, 'state.sqlite')

  const db = new DatabaseSync(stateFile)

  // the migration of the old default `config.json` belongs to the default config: a
  // config named by `-c` is a different node and must not eat it
  const settings = readSettingsFile(root, explicitSettings ? settingsFile : null)
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
  /**
   * Write the settings, keeping the human's comments.
   *
   * The whole YAML machinery (the commented template, the migrations from JSON and
   * from a per-server policy, editing by keys) lives in lib/settings.mjs: there must
   * be exactly one writer, otherwise the CLI and the daemon overwrite each other.
   */
  function saveSettings (patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      settings[key] = value
    }
    // there is no longer a place for tokens and cursors in the config
    const plain = { ...settings }
    delete plain.servers
    delete plain.policy
    writeSettings(root, plain, settingsFile)
    return plain
  }

  // ── the server ─────────────────────────────────────────────────────────
  /** The server this client serves: exactly one, and it is named in the config. */
  function server () {
    const fresh = readSettingsFile(root, explicitSettings ? settingsFile : null)
    if (fresh.server) settings.server = fresh.server
    return settings.server ?? null
  }

  // ── tokens ─────────────────────────────────────────────────────────────
  /**
   * The token file is shared by every config in this directory: it is a list of
   * `{url, token}`, so two nodes on one machine do not overwrite each other's tokens.
   */
  function readCredentials () {
    try {
      if (!existsSync(credentialsFile)) return { nonce: null, servers: {} }
      const parsed = parseYaml(readFileSync(credentialsFile, 'utf8')) ?? {}
      const servers = {}
      // The current format is a list of objects: an editor must not have its eyes
      // broken by url keys. The old format (a url → token map) is read too, otherwise
      // a client update would wipe all the tokens.
      if (Array.isArray(parsed.servers)) {
        for (const entry of parsed.servers) {
          if (typeof entry?.url === 'string' && typeof entry?.token === 'string' && entry.token) {
            servers[entry.url] = entry.token
          }
        }
      } else {
        for (const [url, token] of Object.entries(parsed)) {
          if (url === 'client_nonce') continue
          if (typeof token === 'string' && token) servers[url] = token
        }
      }
      const nonce = typeof parsed.client_nonce === 'string' && parsed.client_nonce ? parsed.client_nonce : null
      return { nonce, servers }
    } catch {
      return { nonce: null, servers: {} }
    }
  }

  function writeCredentials () {
    const body = stringifyYaml({
      ...(credentials.nonce ? { client_nonce: credentials.nonce } : {}),
      servers: Object.entries(credentials.servers ?? {}).map(([url, token]) => ({ url, token })),
    }, { lineWidth: 0 })
    writeFileSync(credentialsFile, body, { mode: 0o600 })
    try {
      chmodSync(credentialsFile, 0o600)
    } catch {}
  }

  /**
   * The client secret for enrollments: a uuid is not a secret, so a token for an
   * enrollment must be obtainable only by whoever knows this nonce. It lives next to
   * the token.
   */
  function clientNonce () {
    // read the file again: several stores live in one process (the daemon, the code
    // exchange, the CLI), and each has its own snapshot
    credentials = readCredentials()
    if (credentials.nonce) return credentials.nonce
    credentials.nonce = randomBytes(24).toString('base64url')
    writeCredentials()
    return credentials.nonce
  }

  /** The token of the server this config serves. */
  function token (url = null) {
    const key = url ?? settings.server
    credentials = readCredentials()
    if (!key) return null
    return credentials.servers[key] ?? null
  }

  function setToken (url, value) {
    const key = url ?? settings.server
    if (!key) return null
    credentials = readCredentials()
    if (value) credentials.servers[key] = value
    else delete credentials.servers[key]
    writeCredentials()
    return value ?? null
  }

  /** Every server this machine has a token for (one file, several configs). */
  function knownServers () {
    credentials = readCredentials()
    return Object.keys(credentials.servers)
  }

  // ── runtime ────────────────────────────────────────────────────────────
  function readState (url = settings.server ?? '') {
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

  function writeState (url = settings.server ?? '', patch = {}) {
    const merged = { ...readState(url), ...patch, url }
    db.prepare(`INSERT INTO server (url, epoch, boot, node, alias, api_ids, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        epoch = excluded.epoch, boot = excluded.boot,
        node = excluded.node, alias = excluded.alias, api_ids = excluded.api_ids,
        updated_at = excluded.updated_at`)
      .run(url ?? '', merged.epoch ?? null, merged.boot ?? null,
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

  /** Forget the server completely: the token and the runtime. The address stays. */
  function forget (url = null) {
    const key = url ?? settings.server
    setToken(key, null)
    db.prepare('DELETE FROM server WHERE url = ?').run(key ?? '')
  }

  /**
   * Import the old config.json (`servers` → the token file and the runtime).
   *
   * This is the `0002_split_config` migration step: the record of what has been applied
   * lives in the `migrations` table, so nothing happens twice.
   */
  function importLegacySettings () {
    const legacy = settings.servers ?? {}
    const urls = Object.keys(legacy)
    credentials = readCredentials()
    for (const url of urls) {
      const entry = legacy[url]
      if (entry?.token) credentials.servers[url] = entry.token
    }
    // a client that knew exactly one server becomes a client of that server: the
    // config names its address from now on, there is no list to consult
    if (!settings.server && urls.length) settings.server = urls[0]
    if (urls.length) writeCredentials()
    // the runtime of the server we now serve moves as well
    const chosen = settings.server ? legacy[settings.server] : null
    if (chosen) {
      writeState(settings.server, {
        epoch: chosen.epoch ?? null,
        boot: chosen.boot ?? null,
        node: chosen.node ?? null,
        alias: chosen.alias ?? null,
        apiIds: chosen.apiIds ?? {},
      })
    }
    // We rewrite the file only if something was really moved: otherwise the migration
    // eats the comments in the config although it was not going to change anything there
    if (!urls.length) return
    delete settings.servers
    // the file is rebuilt from the template: an old config had no comments to lose, and
    // a node coming from JSON gets the explanations along with the migration
    writeFileSync(settingsFile, renderSettings(settings, { dir: root }), { mode: 0o600 })
  }

  // the migration chain — once all the steps and closures are defined
  runMigrations(db)

  return {
    dir: root,
    files: { settings: settingsFile, credentials: credentialsFile, state: stateFile },
    get settings () {
      return settings
    },
    saveSettings,
    server,
    knownServers,
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
    nextClientEpoch (url = settings.server ?? '') {
      const key = 'client_epoch'
      const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key)
      // an old file kept the counter under `client_epoch:<url>` (and before that `conn:`)
      // — we continue that numbering instead of starting from one, otherwise the first
      // connection after the upgrade looks stale to a server that already knows a bigger
      // number
      const legacy = row
        ? null
        : db.prepare('SELECT value FROM meta WHERE key IN (?, ?) ORDER BY value DESC')
          .get(`client_epoch:${url}`, `conn:${url}`)
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
