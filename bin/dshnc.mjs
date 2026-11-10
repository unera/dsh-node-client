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
import * as jobPlugin from '../lib/plugins/job.mjs'
import { loadPlugins } from '../lib/plugins/index.mjs'
import { detectLang, setLang, t } from '../lib/i18n.mjs'
import { applyAutostartAnswers, resolveExecStart, runAutostart } from '../lib/autostart.mjs'
import { formatQuestion } from '../lib/ask.mjs'
import { home, openStore } from '../lib/store.mjs'
import * as api from '../lib/api.mjs'
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
  '  ' + t('help.onboard'),
  '  ' + t('help.config'),
  '  ' + t('help.policy'),
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

async function main (argv) {
  setLang(detectLang())
  const [command, ...rest] = argv
  const config = loadConfig()

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    out(HELP())
    return 0
  }

  // Мастер настройки: меню, а не поток вопросов. Ведёт себя как «первичная
  // настройка», но годится и для правок: текущие значения он предлагает по
  // умолчанию, поэтому пустой ответ ничего не меняет.
  // Событие устройства: кнопка в уведомлении, готовность, что угодно.
  // Обязательны только сессия и текст — остальное по желанию.
  if (command === 'send-session') {
    const args = process.argv.slice(3)
    const readFlag = (name) => {
      const index = args.indexOf(name)
      if (index < 0) return null
      const value = args[index + 1]
      args.splice(index, value === undefined ? 1 : 2)
      return value ?? null
    }
    const rawSession = readFlag('--session')
    // DSH зовёт сессии `session-<uuid>`; человек знает только uuid, поэтому
    // префикс добавляем сами, а если он уже есть — не трогаем
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
    const store = openStore()
    const settings = store.settings ?? {}
    const servers = Object.keys(settings.policy ?? {})
    const base = servers[0]
    if (!base) {
      out('нет сохранённого сервера: сначала dshnc connect <ссылка>')
      return 1
    }
    const token = store.token(base)
    if (!token) {
      out('нет токена для этого сервера: подключись заново')
      return 1
    }
    try {
      const answer = await api.sendEvent(base, token, { session, text, button, purpose, id: eventId })
      out(`отправлено в сессию ${answer.session ?? session} (устройство: ${answer.device ?? 'это'})`)
      return 0
    } catch (error) {
      // коды переводим в человеческую речь: 404 и 403 человек должен понять сразу
      const map = {
        404: `сессии ${session} больше нет: возможно, её удалили или закрыли`,
        403: 'для этого устройства события выключены в админке',
        400: 'сервер не принял событие: проверь номер сессии и текст',
      }
      // сервер присылает причину своими словами — она важнее нашей заготовки
      out(error.message && !/^HTTP \d+$/.test(error.message) ? error.message : (map[error.status] ?? 'сервер не ответил'))
      return 1
    }
  }

  if (command === 'onboard') {
    const store = openStore()
    const { runOnboard, pickPolicy } = await import('../lib/onboard.mjs')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const ask = async (question) => {
      const answer = await rl.question(question)
      return answer
    }
    try {
      await runOnboard({
        ask,
        print: (line) => out(line),
        load: () => openStore().settings ?? {},
        save: (patch) => openStore().saveSettings(patch),
        autostart: async (cfg) => {
          const answers = await runAutostart({
            ask,
            print: (line) => out(line),
            config: cfg ?? {},
            execStart: resolveExecStart(process.argv[1]),
            hasSudo: process.env.DSHNC_SUDO === '1',
          })
          applyAutostartAnswers(cfg ?? {}, answers)
        },
        status: (cfg) => {
          const { url, policy } = pickPolicy(cfg ?? {})
          return [
            `узел: ${cfg?.name ?? '—'}`,
            `сервер: ${url ?? 'не подключён'}`,
            `каталоги: ${(policy.roots ?? cfg?.roots ?? []).join(', ') || '—'}`,
            `режимы: base ${policy.base ?? '—'}, потолок ${policy.max ?? '—'}, вопросы ${policy.approver ?? '—'}`,
            `связь: пинг ${cfg?.pingInterval ?? 0} с`,
          ]
        },
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
      try {
        openStore().saveSettings({ workdir: dir })
      } catch (error) {
        process.stderr.write(t('err.writeState', { message: error.message }) + '\n')
        return 1
      }
      config.workdir = dir
      out(t('workdir.set', { dir: config.workdir }))
    } else {
      out(config.workdir ?? t('workdir.none'))
    }
    return 0
  }

  if (command === 'policy') {
    const store = openStore()
    const [url, ...pairs] = rest
    if (!url) {
      out(t('policy.current', { access: JSON.stringify(config.access ?? {}), roots: (config.roots ?? []).join(', ') || '—' }))
      for (const [key, value] of Object.entries(config.policy ?? {})) {
        out(`${key}: ${JSON.stringify(value)}`)
      }
      return 0
    }
    const target = normalizeUrl(url)
    const patch = {}
    for (const pair of pairs) {
      // делим по первому «=»: значение само может содержать «=» (zenity --width=600)
      const at = pair.indexOf('=')
      if (at < 0) continue
      const key = pair.slice(0, at)
      const value = pair.slice(at + 1)
      if (!value) continue
      if (key === 'max') patch.max = value
      if (key === 'ask') patch.ask = value === 'true' || value === '1'
      if (key === 'roots') patch.roots = value.split(':').filter(Boolean)
      if (key === 'base') patch.base = value
      if (key === 'approver') patch.approver = value
      if (key === 'tool') {
        // внешний инструмент локального апрува: включаем канал и запоминаем команду
        patch.ask = { local: { enabled: true, tool: { type: 'external', command: value } } }
      }
      if (key === 'workdir') patch.workdir = resolve(value)
    }
    if (!Object.keys(patch).length) {
      out(JSON.stringify(config.policy?.[target] ?? {}, null, 2))
      return 0
    }
    config.policy ??= {}
    config.policy[target] = { ...(config.policy[target] ?? {}), ...patch }
    try {
      store.saveSettings({ policy: config.policy })
    } catch (error) {
      // частая причина — попытка поменять политику изнутри песочницы: писать
      // в ~/.dshnc там нельзя, и молчать об этом нельзя тоже
      process.stderr.write(t('err.writeState', { message: error.message }) + '\n')
      return 1
    }
    out(t('policy.saved', { url: target, patch: JSON.stringify(patch) }))
    return 0
  }

  // Настройки верхнего уровня: то, что относится к самому клиенту, а не к
  // конкретному серверу. Нужны, чтобы менять поведение без правки файла руками
  // (и без риска сломать YAML-комментарии).
  if (command === 'config') {
    const store = openStore()
    const pairs = rest
    if (!pairs.length) {
      const plain = { ...config }
      delete plain.servers
      delete plain.policy
      out(JSON.stringify(plain, null, 2))
      return 0
    }
    const patch = {}
    for (const pair of pairs) {
      const at = pair.indexOf('=')
      if (at < 0) continue
      const key = pair.slice(0, at)
      const raw = pair.slice(at + 1)
      if (!key || raw === '') continue
      const value = /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === 'true' ? true : raw === 'false' ? false : raw
      patch[key] = value
    }
    if (!Object.keys(patch).length) {
      out(t('config.usage'))
      return 1
    }
    try {
      store.saveSettings(patch)
    } catch (error) {
      process.stderr.write(t('err.writeState', { message: error.message }) + '\n')
      return 1
    }
    out(t('config.saved', { patch: JSON.stringify(patch) }))
    return 0
  }

  if (command === 'audit') {
    const limit = Number(rest[0]) > 0 ? Number(rest[0]) : 20
    const rows = openStore().readAudit(limit)
    if (!rows.length) {
      out(t('audit.empty'))
      return 0
    }
    for (const row of rows) {
      // локальное время: аудит читает человек, а не машина
      const when = new Date(row.at).toLocaleString('sv-SE').replace('T', ' ')
      const session = (row.session ?? '—').replace(/^session-/, '').slice(0, 8)
      out(`${when}  ${row.mode}  код ${row.code ?? '—'}  ${session}  ${row.command.replace(/\s+/g, ' ').slice(0, 120)}`)
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
      // фоновые процессы умирают вместе с демоном: иначе после остановки
      // сервиса на машине остаются работать задания, о которых никто не знает
      try {
        jobPlugin.stopAll()
      } catch {}
      controller.abort()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    // SIGHUP обрабатывает сам раннер: он же будит спящий цикл и переобъявляет
    // API. Здесь ничего не делаем, чтобы не было двух источников правды.
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
