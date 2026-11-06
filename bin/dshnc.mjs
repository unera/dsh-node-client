#!/usr/bin/env node
/**
 * dshnc — клиент dsh-nodes.
 *
 *   dshnc help
 *   dshnc connect <url>        заявка на сервере и ожидание одобрения
 *   dshnc daemon [url...]      держать соединения и исполнять команды
 *   dshnc status               что сохранено в ~/.dshnc
 *
 * Один клиент может работать с несколькими серверами: состояние соединений
 * (токен, курсор, epoch) хранится per URL.
 */
import { join } from 'node:path'
import { loadConfig, normalizeUrl, saveConfig, home } from '../lib/config.mjs'
import { enrollServer, pairServer, runServer } from '../lib/runner.mjs'
import { loadPlugins } from '../lib/plugins/index.mjs'

const HELP = `dshnc — клиент dsh-nodes (${home()})

  connect <url>            подключиться: ссылка с кодом связывает всё сама,
                           без кода — заявка и ожидание одобрения в админке
  daemon [url...]          работать: объявить bash, забирать команды, отвечать
                           без аргументов — все серверы из конфига;
                           работает на переднем плане (фон — через systemd/nohup)
  --foreground             оставлено для совместимости, поведение то же
  status                   показать id клиента и сохранённые серверы
  help                     этот экран

  Переменные: DSHNC_HOME (каталог состояния), DSHNC_SHELL (шелл, по умолчанию /bin/sh)
`

const out = (line) => process.stdout.write(`${line}\n`)

async function main (argv) {
  const [command, ...rest] = argv
  const config = loadConfig()

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP)
    return 0
  }

  if (command === 'status') {
    out(`id клиента: ${config.id}`)
    out(`имя:        ${config.name}`)
    const servers = Object.entries(config.servers ?? {})
    if (!servers.length) {
      out('серверов нет — начни с `dshnc connect <url>`')
      return 0
    }
    for (const [url, state] of servers) {
      out(`${url}: ${state.token ? 'токен есть' : 'токена нет'}, курсор ${state.cursor ?? '—'}, epoch ${state.epoch ?? '—'}${state.alias ? `, узел ${state.alias}` : ''}`)
    }
    return 0
  }

  if (command === 'connect') {
    const url = rest[0]
    if (!url) {
      process.stderr.write('нужен url: dshnc connect https://dsh.example/dsh-nodes/pair?v=...\n')
      return 2
    }
    const withCode = url.includes('?')
    const state = withCode
      ? await pairServer({ url, config, print: out })
      : await enrollServer({ url: normalizeUrl(url), config, print: out })
    saveConfig(config)
    out('готово. дальше: dshnc daemon')
    return state ? 0 : 1
  }

  if (command === 'daemon') {
    const urls = rest.filter((arg) => !arg.startsWith('--'))
    const targets = urls.length ? urls.map(normalizeUrl) : Object.keys(config.servers ?? {})
    if (!targets.length) {
      process.stderr.write('нечего обслуживать: сначала `dshnc connect <url>`\n')
      return 2
    }
    const controller = new AbortController()
    const stop = () => {
      out('останавливаюсь')
      controller.abort()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    const plugins = await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => out(message) })
    out(`серверы: ${targets.join(', ')}`)
    out(`плагины: ${plugins.map((plugin) => plugin.api.name).join(', ')}`)
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

  process.stderr.write(`неизвестная команда: ${command}\n\n${HELP}`)
  return 2
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
  process.stderr.write(`ошибка: ${error.message}\n`)
  process.exit(1)
})
