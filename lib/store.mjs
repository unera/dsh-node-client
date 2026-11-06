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
import { randomBytes } from 'node:crypto'
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

  const settings = readSettings()
  let credentials = readCredentials()

  /**
   * Прогнать миграции схемы.
   *
   * Правило проекта: схема `state.sqlite` меняется только цепочкой миграций,
   * и цепочка исполняется при открытии хранилища. Учёт исполненных — в самой
   * БД, в таблице `migrations`: повторно шаг не применяется никогда, даже если
   * файл открыли старым клиентом и вернули новый.
   *
   * Рантайм (курсор, epoch, apiIds) восстановим: клиент заново объявится, и
   * сервер сам скажет сбросить курсор при смене поколения. Поэтому шаг миграции
   * вправе пересоздать таблицу, а не героически спасать данные.
   *
   * @param {DatabaseSync} database
   */
  /**
   * Цепочка миграций схемы. Каждый шаг имеет постоянный `id`; порядок в массиве
   * и есть порядок применения. Удалять и переименовывать шаги нельзя — только
   * добавлять новые в конец.
   */
  const migrations = [
    { id: '0001_init', up: () => {} },
    { id: '0002_split_config', up: () => importLegacySettings() },
    {
      // сессия может переехать в другой каталог (плагин `session`), и выбор
      // должен пережить рестарт демона
      id: '0003_session_workdir',
      up: (database) => database.exec(`CREATE TABLE IF NOT EXISTS session_workdir (
        session TEXT PRIMARY KEY,
        workdir TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
    },
  ]

  function runMigrations (database) {
    database.exec(`CREATE TABLE IF NOT EXISTS server (
      url TEXT PRIMARY KEY,
      cursor INTEGER,
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
      // Текущий формат — список объектов: редактор не должен ломать глаза о
      // ключи-урлы. Старый формат (карта url → token) читаем тоже, иначе
      // обновление клиента стёрло бы все токены.
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
   * Секрет клиента для заявок: uuid не секрет, поэтому токен по заявке должен
   * получить только тот, кто знает этот nonce. Живёт рядом с токенами.
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

  /** Каталог сессии, выбранный через плагин `session`. */
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

  /**
   * Перенос старого config.json (servers → токены + рантайм).
   *
   * Это шаг миграции `0002_split_config`: учёт исполненного лежит в таблице
   * `migrations`, поэтому повторно ничего не произойдёт.
   */
  function importLegacySettings () {
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
  }

  // цепочка миграций — когда все шаги и замыкания уже определены
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
    readSessionDir,
    writeSessionDir,
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
