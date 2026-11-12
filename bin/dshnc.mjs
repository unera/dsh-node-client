#!/usr/bin/env node
/**
 * dshnc - the dsh-nodes client.
 *
 *   dshnc help
 *   dshnc connect <url>        apply on the server and wait for approval
 *   dshnc daemon               hold the connection and execute commands
 *   dshnc status               what is saved in ~/.dshnc
 *   dshnc version              client version and protocol version
 *
 * One client serves one server: the address is a key of the config. A second node
 * on the same machine is a second config, chosen with `-c/--config <file>` — the
 * tokens and the runtime stay common, because they are keyed by address.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { loadConfig, normalizeUrl } from '../lib/config.mjs'
import { connectTo } from '../lib/connect.mjs'
import { enrollServer, pairServer, runServer } from '../lib/runner.mjs'
import * as jobPlugin from '../lib/plugins/job.mjs'
import { loadPlugins } from '../lib/plugins/index.mjs'
import { detectLang, setLang, t } from '../lib/i18n.mjs'
import { applyAutostartAnswers, resolveExecStart, runAutostart } from '../lib/autostart.mjs'
import { formatQuestion } from '../lib/ask.mjs'
import { home, openStore } from '../lib/store.mjs'
import * as api from '../lib/api.mjs'
import { VERSION } from '../lib/api.mjs'

const HELP = () => [
  t('help.title', { home: home() }),
  '',
  '  ' + t('help.configFile'),
  '  ' + t('help.connect'),
  '  ' + t('help.connect2'),
  '  ' + t('help.daemon'),
  '  ' + t('help.daemon2'),
  '  ' + t('help.foreground'),
  '  ' + t('help.onboard'),
  '  ' + t('help.config'),
  '  ' + t('help.audit'),
  '  ' + t('help.workdir'),
  '  ' + t('help.autostart'),
  '  ' + t('help.status'),
  '  ' + t('help.version'),
  '  ' + t('help.help'),
  '',
  '  ' + t('help.env'),
  '',
].join('\n')

const out = (line) => process.stdout.write(`${line}\n`)
const err = (line) => process.stderr.write(`${line}\n`)

/**
 * Pull `-c/--config` out of the arguments.
 *
 * The path goes into `DSHNC_CONFIG`, so that every module that opens the store — the
 * daemon loop, the plugins, the enrollment — works with the same config without
 * threading the path through half of the code.
 */
export function takeConfigPath (argv) {
  const rest = []
  let configPath = null
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-c' || arg === '--config') {
      configPath = argv[index + 1] ?? null
      index += 1
      continue
    }
    if (arg.startsWith('--config=')) {
      configPath = arg.slice('--config='.length)
      continue
    }
    if (arg.startsWith('-c') && arg.length > 2) {
      configPath = arg.slice(2)
      continue
    }
    rest.push(arg)
  }
  return { configPath, argv: rest }
}

async function main (argvIn) {
  setLang(detectLang())
  const { configPath, argv } = takeConfigPath(argvIn)
  if (configPath) process.env.DSHNC_CONFIG = resolve(configPath)
  const store = () => openStore({ configPath })
  const [command, ...rest] = argv
  const config = loadConfig({ configPath })

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP())
    return 0
  }

  // Device event: a button in a notification, readiness, anything.
  // Only the session and the text are required - the rest is optional.
  if (command === 'send-session') {
    const args = rest.slice()
    const readFlag = (name) => {
      const index = args.indexOf(name)
      if (index < 0) return null
      const value = args[index + 1]
      args.splice(index, value === undefined ? 1 : 2)
      return value ?? null
    }
    const rawSession = readFlag('--session')
    // DSH calls sessions `session-<uuid>`; the human only knows the uuid, so
    // we add the prefix ourselves and leave it alone if it is already there
    const session = rawSession && /^[0-9a-f-]{36}$/i.test(rawSession.trim())
      ? `session-${rawSession.trim()}`
      : rawSession
    const button = readFlag('--button')
    const purpose = readFlag('--purpose')
    const eventId = readFlag('--id') ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const text = args.filter((item) => !item.startsWith('--')).join(' ').trim()
    if (!session) {
      out('нужен номер сессии: --session <id>. Номер видно в админке или в ссылке на сессию.')
      return 1
    }
    if (!text) {
      out('нужен текст события: например dshnc send-session --session <id> "перезагрузи dsh"')
      return 1
    }
    const base = config.server ?? store().server()
    if (!base) {
      out('в конфиге нет сервера: сначала dshnc connect <ссылка>')
      return 1
    }
    const token = store().token(base)
    if (!token) {
      out('нет токена для этого сервера: подключись заново')
      return 1
    }
    try {
      const answer = await api.sendEvent(base, token, { session, text, button, purpose, id: eventId })
      out(`отправлено в сессию ${answer.session ?? session} (устройство: ${answer.device ?? 'это'})`)
      return 0
    } catch (error) {
      // translate the codes into human speech: 404 and 403 must be clear at once
      const map = {
        404: `сессии ${session} больше нет: возможно, её удалили или закрыли`,
        403: 'для этого устройства события выключены в админке',
        400: 'сервер не принял событие: проверь номер сессии и текст',
      }
      // the server sends its reason in its own words - it matters more than our stub
      out(error.message && !/^HTTP \d+$/.test(error.message) ? error.message : (map[error.status] ?? 'сервер не ответил'))
      return 1
    }
  }

  if (command === 'onboard') {
    const { runOnboard } = await import('../lib/onboard.mjs')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (question) => {
      const answer = await rl.question(question)
      return answer
    }
    try {
      await runOnboard({
        ask,
        print: (line) => out(line),
        load: () => store().settings ?? {},
        save: (patch) => store().saveSettings(patch),
        autostart: async (cfg) => {
          const answers = await runAutostart({
            ask,
            print: (line) => out(line),
            config: cfg ?? {},
            execStart: resolveExecStart(process.argv[1]),
            hasSudo: process.env.DSHNC_SUDO === '1',
            hasToken: store().knownServers().length > 0,
          })
          applyAutostartAnswers(cfg ?? {}, answers)
        },
        connect: (target) => connectTo({ target, config, store, print: out }),
        status: (cfg) => [
          `узел: ${cfg?.name ?? '—'}`,
          `сервер: ${cfg?.server ?? 'не подключён'}`,
          `каталоги: ${(cfg?.roots ?? []).join(', ') || '—'}`,
          `режимы: base ${cfg?.base ?? '—'}, потолок ${cfg?.max ?? '—'}, вопросы ${cfg?.approver ?? '—'}`,
          `связь: пинг ${cfg?.pingInterval ?? 0} с`,
        ],
      })
    } finally {
      rl.close()
    }
    return 0
  }

  if (command === 'autostart') {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (question, fallback) => {
      const answer = await rl.question(formatQuestion(question, fallback))
      return answer.trim() || fallback || ''
    }
    try {
      const result = await runAutostart({
        ask,
        print: out,
        config,
        execStart: resolveExecStart(process.argv[1]),
        hasSudo: process.env.DSHNC_SUDO === '1',
        hasToken: store().knownServers().length > 0,
      })
      applyAutostartAnswers(config, result)
      store().saveSettings({ name: config.name, aliases: config.aliases })
      out(t('auto.nodeSummary', { name: config.name })
        + (config.aliases?.length ? t('auto.aliasesSuffix', { aliases: config.aliases.join(', ') }) : ''))
    } finally {
      rl.close()
    }
    return 0
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    out(t('version.line', { version: VERSION }))
    return 0
  }

  if (command === 'workdir') {
    if (rest[0]) {
      const dir = resolve(rest[0])
      mkdirSync(dir, { recursive: true })
      try {
        store().saveSettings({ workdir: dir })
      } catch (error) {
        err(t('err.writeState', { message: error.message }))
        return 1
      }
      config.workdir = dir
      out(t('workdir.set', { dir: config.workdir }))
    } else {
      out(config.workdir ?? t('workdir.none'))
    }
    return 0
  }

  if (command === 'config') {
    if (!rest.length) {
      out(JSON.stringify(render(), null, 2))
      return 0
    }
    const patch = {}
    for (const pair of rest) {
      // split at the first "=": the value itself may contain "=" (zenity --width=600)
      const at = pair.indexOf('=')
      if (at < 0) continue
      const key = pair.slice(0, at)
      const raw = pair.slice(at + 1)
      if (!key || raw === '') continue
      const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw
      if (key === 'roots') patch.roots = raw.split(':').filter(Boolean)
      else if (key === 'workdir') patch.workdir = resolve(raw)
      else if (key === 'tool') {
        // external local approval tool: enable the channel and remember the command
        patch.ask = { local: { enabled: true, tool: { type: 'external', command: raw } } }
      } else patch[key] = value
    }
    if (!Object.keys(patch).length) {
      out(t('config.usage'))
      return 1
    }
    try {
      store().saveSettings(patch)
    } catch (error) {
      err(t('err.writeState', { message: error.message }))
      return 1
    }
    out(t('config.saved', { patch: JSON.stringify(patch) }))
    return 0
  }

  if (command === 'audit') {
    const limit = Number(rest[0]) > 0 ? Number(rest[0]) : 20
    const rows = store().readAudit(limit)
    if (!rows.length) {
      out(t('audit.empty'))
      return 0
    }
    for (const row of rows) {
      // local time: the audit is read by a human, not by a machine
      const when = new Date(row.at).toLocaleString('sv-SE').replace('T', ' ')
      const session = (row.session ?? '—').replace(/^session-/, '').slice(0, 8)
      out(`${when}  ${row.mode}  код ${row.code ?? '—'}  ${session}  ${row.command.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
    return 0
  }

  if (command === 'status') {
    out(t('status.id', { id: config.id }))
    out(t('status.name', { name: config.name }))
    const server = config.server ?? store().server()
    if (!server) {
      out(t('status.none'))
      return 0
    }
    const state = { ...store().readState(server), token: store().token(server) }
    out(t('status.server', {
      url: server,
      token: state.token ? t('status.token.yes') : t('status.token.no'),
      epoch: state.epoch ?? '—',
      alias: state.alias ? t('status.alias', { alias: state.alias }) : '',
    }))
    out(t('status.config', { file: store().files.settings }))
    return 0
  }

  if (command === 'connect') {
    const url = rest[0]
    if (!url) {
      err(t('err.needUrl'))
      return 2
    }
    // the address becomes a key of the config: from now on this node serves exactly
    // this server, and `daemon` does not need to be told again
    const address = await connectTo({ target: { link: url }, config, store, print: out })
    out(t('connect.done'))
    return address ? 0 : 1
  }

  if (command === 'daemon') {
    const extra = rest.filter((arg) => !arg.startsWith('--'))
    if (extra.length) {
      err(t('err.oneServer'))
      return 2
    }
    const url = config.server ?? store().server()
    if (!url) {
      err(t('err.nothingToServe'))
      return 2
    }
    const controller = new AbortController()
    const stop = () => {
      out(t('daemon.stopping'))
      // background processes die with the daemon: otherwise after the service stops
      // jobs nobody knows about are left running on the machine
      try {
        jobPlugin.stopAll()
      } catch {}
      controller.abort()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    // SIGHUP is handled by the runner itself: it also wakes the sleeping loop and
    // re-announces the API. We do nothing here so there is no second source of truth.
    const plugins = await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => out(message) })
    out(t('version.line', { version: VERSION }))
    out(t('daemon.server', { server: url }))
    out(t('daemon.configFile', { file: store().files.settings }))
    out(t('daemon.plugins', { plugins: plugins.map((plugin) => plugin.api.name).join(', ') }))
    const shell = process.env.DSHNC_SHELL ?? '/bin/sh'
    await runServer({
      url,
      config,
      print: (line) => out(line),
      signal: controller.signal,
      shell,
      plugins,
    }).catch((error) => {
      if (error.message !== 'aborted') err(`${url}: ${error.message}`)
    })
    return 0
  }

  err(t('cmd.unknown', { command }) + '\n\n' + HELP())
  return 2
}

/** What `dshnc config` prints: the settings without the noise. */
function render () {
  const config = loadConfig({ configPath: process.env.DSHNC_CONFIG ?? null })
  delete config.id
  return config
}

const code = await main(process.argv.slice(2))
process.exitCode = code
