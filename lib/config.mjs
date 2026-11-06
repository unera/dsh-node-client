/**
 * Клиент dsh-nodes: состояние в ~/.dshnc, соединения по URL.
 *
 * Один клиент может работать с несколькими серверами, поэтому всё, что
 * относится к соединению (токен, курсор, epoch, реконнект), хранится по URL.
 *
 * @module dsh-node-client/config
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Каталог состояния. `DSHNC_HOME` переопределяет (удобно в тестах). */
export function home () {
  return process.env.DSHNC_HOME ?? join(homedir(), '.dshnc')
}

function ensureDir (dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Конфиг: id клиента и профили подключений. */
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
  return config
}

export function saveConfig (config) {
  const dir = home()
  ensureDir(dir)
  const file = join(dir, 'config.json')
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/** Запись одного сервера: токен, курсор, epoch поколения. */
export function serverState (config, url) {
  config.servers ??= {}
  config.servers[url] ??= { token: null, cursor: null, epoch: null, boot: null }
  return config.servers[url]
}

/** Нормализовать URL: без хвостового слэша и с базовым путём dsh-nodes. */
export function normalizeUrl (input) {
  const url = new URL(input)
  url.hash = ''
  url.search = ''
  let path = url.pathname.replace(/\/+$/, '')
  if (!path) path = '/dsh-nodes'
  return `${url.origin}${path}`
}
