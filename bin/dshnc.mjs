#!/usr/bin/env node
/**
 * dshnc — клиент dsh-nodes.
 *
 *   dshnc help
 *   dshnc connect <url>        заявка на сервере и ожидание одобрения
 *   dshnc daemon [url...]      держать соединения и исполнять команды
 *   dshnc status               что сохранено в ~/.dshnc
 *   dshnc version              версия клиента и версия протокола
 *
 * Один клиент может работать с несколькими серверами: состояние соединений
 * (токен, курсор, epoch) хранится per URL.
 */
import { join } from 'node:path'
import { loadConfig, normalizeUrl } from '../lib/config.mjs'
import { enrollServer, pairServer, runServer } from '../lib/runner.mjs'
import { loadPlugins } from '../lib/plugins/index.mjs'
import { detectLang, setLang, t } from '../lib/i18n.mjs'
import { applyAutostartAnswers, resolveExecStart, runAutostart } from '../lib/autostart.mjs'
import { formatQuestion } from '../lib/ask.mjs'
import { home, openStore } from '../lib/store.mjs'
import { PROTO, VERSION } from '../lib/api.mjs'
import { createInterface } from 'node:readline/promises'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const HELP = () => [
  t('help.title', { home: home() }),
  '',
  '  ' + t('help.connect'),
  '  ' + t('help.connect2'),
  '  ' + t('help.daemon'),
  '  ' + t('help.daemon2'),
  '  ' + t('help.daemon3'),
  '  ' + t('help.foreground'),
  '  ' + t('help.status'),
  '  ' + t('help.version'),
  '  ' + t('help.help'),
  '',
  '  ' + t('help.env'),
  '',
].join('\n')

const out = (line) => process.stdout.write(`${line}\n`)

async function main (argv) {
  setLang(detectLang())
  const [command, ...rest] = argv
  const config = loadConfig()

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP())
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
      })
      applyAutostartAnswers(config, result)
      openStore().saveSettings({ name: config.name, aliases: config.aliases })
      out(t('auto.nodeSummary', { name: config.name })
        + (config.aliases?.length ? t('auto.aliasesSuffix', { aliases: config.aliases.join(', ') }) : ''))
    } finally {
      rl.close()
    }
    return 0
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    out(t('version.line', { version: VERSION, proto: PROTO }))
    return 0
  }

  if (command === 'workdir') {
    if (rest[0]) {
      const dir = resolve(rest[0])
      mkdirSync(dir, { recursive: true })
      openStore().saveSettings({ workdir: dir })
      config.workdir = dir
      out(t('workdir.set', { dir: config.workdir }))
    } else {
      out(config.workdir ?? t('workdir.none'))
    }
    return 0
  }

  if (command === 'status') {
    out(t('status.id', { id: config.id }))
    out(t('status.name', { name: config.name }))
    const store = openStore()
    const servers = store.servers()
    if (!servers.length) {
      out(t('status.none'))
      return 0
    }
    for (const url of servers) {
      const state = { ...store.readState(url), token: store.token(url) }
      out(t('status.server', {
        url,
        token: state.token ? t('status.token.yes') : t('status.token.no'),
        cursor: state.cursor ?? '—',
        epoch: state.epoch ?? '—',
        alias: state.alias ? t('status.alias', { alias: state.alias }) : '',
      }))
    }
    return 0
  }

  if (command === 'connect') {
    const url = rest[0]
    if (!url) {
      process.stderr.write(t('err.needUrl') + '\n')
      return 2
    }
    const withCode = url.includes('?')
    const state = withCode
      ? await pairServer({ url, config, print: out })
      : await enrollServer({ url: normalizeUrl(url), config, print: out })
    out(t('connect.done'))
    return state ? 0 : 1
  }

  if (command === 'daemon') {
    const urls = rest.filter((arg) => !arg.startsWith('--'))
    const targets = urls.length ? urls.map(normalizeUrl) : openStore().servers()
    if (!targets.length) {
      process.stderr.write(t('err.nothingToServe') + '\n')
      return 2
    }
    const controller = new AbortController()
    const stop = () => {
      out(t('daemon.stopping'))
      controller.abort()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    const plugins = await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => out(message) })
    out(t('version.line', { version: VERSION, proto: PROTO }))
    out(t('daemon.servers', { servers: targets.join(', ') }))
    out(t('daemon.plugins', { plugins: plugins.map((plugin) => plugin.api.name).join(', ') }))
    const shell = process.env.DSHNC_SHELL ?? '/bin/sh'
    await Promise.all(targets.map((url) => runServer({
      url,
      config,
      print: (line) => out(line),
      signal: controller.signal,
      shell,
      plugins,
    }).catch((error) => {
      if (error.message !== 'aborted') process.stderr.write(`${url}: ${error.message}\n`)
    })))
    return 0
  }

  process.stderr.write(t('cmd.unknown', { command }) + '\n\n' + HELP())
  return 2
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(t('err.generic', { message: error.message }) + '\n')
  process.exit(1)
})
