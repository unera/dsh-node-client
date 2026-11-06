/**
 * Соединение с одним сервером: заявка, объявление, цикл команд.
 *
 * Состояние держится per URL (план клиента): курсор, epoch, токен. Реконнект —
 * экспоненциальная пауза, но без потери уже полученного токена.
 *
 * @module dsh-node-client/runner
 */
import * as api from './api.mjs'
import { runBash } from './bash.mjs'
import { join } from 'node:path'
import { home, normalizeUrl, serverState, saveConfig } from './config.mjs'
import { openPresence } from './presence.mjs'
import { apisOf, loadPlugins, resolvePlugin } from './plugins/index.mjs'
import { t } from './i18n.mjs'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener?.('abort', () => {
    clearTimeout(timer)
    reject(new Error('aborted'))
  }, { once: true })
})

/**
 * Подключение по ссылке с кодом: подтверждать нечего, код всё связывает сам.
 * @returns {Promise<object>} запись сервера с токеном
 */
export async function pairServer ({ url, config, print }) {
  const { base, code } = api.parseConnectUrl(url)
  if (!code) throw new Error(t('connect.noCode'))
  const state = serverState(config, base)
  const response = await api.pair(base, { code, uuid: config.id, name: config.name, aliases: config.aliases })
  state.token = response.body.token
  state.cursor = 0
  state.epoch = null
  state.alias = response.body.alias ?? null
  state.node = response.body.node ?? null
  delete state.announced
  saveConfig(config)
  print(t('connect.paired', { node: response.body.node, alias: response.body.alias }))
  return state
}

/**
 * Первичная регистрация: заявка и ожидание одобрения человеком.
 * @param {object} options
 * @param {string} options.url
 * @param {object} options.config
 * @param {(line: string) => void} options.print
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} запись сервера с токеном
 */
export async function enrollServer ({ url, config, print, signal, forever = false }) {
  const base = normalizeUrl(url)
  const state = serverState(config, base)
  const uuid = config.id
  let announced = false
  let attempts = 0
  let repost = 0
  let retryMs = 5000
  for (;;) {
    if (signal?.aborted) throw new Error('aborted')
    // заявку повторяем, если она старая: у неё свой TTL в админке
    if (!announced || repost >= 30) {
      try {
        await api.enroll(base, { uuid, name: config.name, aliases: config.aliases })
        if (!announced) {
          print(t('connect.requested', { name: config.name, short: uuid.slice(0, 8) }))
          print(t('connect.waiting', { base }))
        }
        announced = true
        repost = 0
      } catch (error) {
        if (error.code === 'unauthorized') throw error
        announced = false
      }
    }
    repost += 1
    try {
      const response = await api.enrollStatus(base, uuid)
      if (response.status === 200 && response.body?.token) {
        state.token = response.body.token
        state.cursor = 0
        state.epoch = null
        state.alias = response.body.alias ?? null
        state.node = response.body.node ?? null
        delete state.announced
        saveConfig(config)
        print(t('connect.approved', { node: response.body.node ?? '?', alias: response.body.alias ?? '—' }))
        return state
      }
      if (response.body?.status === 'rejected') throw new Error(t('connect.rejected'))
      if (response.body?.status === 'handed') throw new Error(t('connect.handed'))
    } catch (error) {
      if (error.code === 'unauthorized') throw error
      if (/отклон|rejected/.test(error.message)) throw error
      // 409 «уже выдан» — сервер не знает, что нам нужен новый токен: ждём
      // одобрения в админке и напоминаем о себе всё реже, а не каждые 5 секунд
      print(t('run.retry', { base, message: error.message, seconds: Math.round(retryMs / 1000) }))
      await sleep(retryMs, signal)
      retryMs = Math.min(Math.round(retryMs * 2), 60000)
      continue
    }
    attempts += 1
    if (!forever && attempts > 360) throw new Error(t('connect.timeout'))
    await sleep(2000, signal)
  }
}

/**
 * Цикл одного сервера. Возвращается только по отмене или фатальной ошибке.
 */
export async function runServer ({ url, config, print, signal, shell, pollIdleMs = 5000, plugins = null }) {
  const base = normalizeUrl(url)
  const state = serverState(config, base)
  const loaded = plugins ?? await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => print(message) })
  let backoff = 1000
  // `announced` живёт в памяти процесса, а не в конфиге: после рестарта клиента
  // объявляться надо снова — сервер мог перезапуститься, контракт мог измениться.
  let announced = false
  let presence = null
  let wake = null
  /** Разбудить цикл: пришёл кадр `state`, опрос ждать не надо. */
  const nudge = () => {
    const resolve = wake
    wake = null
    resolve?.()
  }
  /**
   * Пауза, которую может прервать уведомление с сервера.
   *
   * Таймер НЕ unref: idle-ожидание — единственное, что держит процесс живым,
   * когда сокета нет (например, присутствие не поднялось). С unref демон
   * молча выходил с кодом 0 после первой же паузы.
   */
  const pause = (ms) => new Promise((resolve) => {
    wake = resolve
    const timer = setTimeout(() => {
      wake = null
      resolve()
    }, ms)
    signal?.addEventListener?.('abort', () => {
      clearTimeout(timer)
      wake = null
      resolve()
    }, { once: true })
  })

  while (!signal?.aborted) {
    try {
      // демон без токена сам идёт в заявку и ждёт одобрения: тогда из админки
      // связь появляется сама, без перезапуска клиента
      if (!state.token) await enrollServer({ url: base, config, print, signal, forever: true })
      if (!announced) {
        const response = await api.announce(base, state.token, apisOf(loaded), { workdir: config.workdir ?? null })
        announced = true
        state.epoch = response.body.epoch ?? null
        state.apiIds = {}
        for (const entry of response.body.apis ?? []) state.apiIds[entry.name] = entry.id
        saveConfig(config)
        const names = (response.body.apis ?? []).map((entry) => `${entry.name}#${entry.id}`).join(', ')
        print(t('run.announced', { base, apis: names, epoch: state.epoch }))
        for (const warning of response.body.warnings ?? []) print(t('run.warning', { warning }))
      }

      if (!presence) presence = openPresence({
        workdir: config.workdir ?? null,
        base,
        token: state.token,
        epoch: state.epoch,
        known: state.cursor ?? null,
        log: (level, message) => print(`${base}: ${message}`),
        onEvent: (event) => {
          if (event.type === 'hello-ok') {
            if (event.reconnect) {
              print(t('run.reconnect', { base, from: state.epoch, to: event.epoch }))
              state.epoch = event.epoch
              state.cursor = 0
              saveConfig(config)
            } else {
              state.epoch = event.epoch ?? state.epoch
            }
            // сразу сообщаем курсор: сервер запомнит, что узел ждёт работы,
            // и первая же команда придёт кадром, а не через период опроса
            presence?.sendAlive(state.cursor ?? null)
            nudge()
          }
          if (event.type === 'state') nudge()
          if (event.type === 'closed') {
            print(t('run.presenceClosed', { base, code: event.code }))
            presence = null
          }
        },
      })

      // сверка поколений: несовпадение = реконнект, курсор в ноль (§4.7)
      const current = await api.state(base, state.token)
      if (state.epoch != null && current.body.epoch !== state.epoch) {
        print(t('run.restarted', { base, from: state.epoch, to: current.body.epoch }))
        state.epoch = current.body.epoch
        state.cursor = 0
        saveConfig(config)
      }

      const response = await api.commands(base, state.token, { after: state.cursor ?? 0 })
      const commands = response.body.commands ?? []
      if (state.epoch !== response.body.epoch) {
        state.epoch = response.body.epoch
        state.cursor = 0
      }
      if (!commands.length) {
        state.cursor = response.body.state ?? state.cursor ?? 0
        saveConfig(config)
        presence?.sendAlive(state.cursor)
        await pause(pollIdleMs)
        continue
      }
      backoff = 1000
      for (const command of commands) {
        const plugin = resolvePlugin(loaded, command, state.apiIds ?? {})
        const outcome = plugin
          ? await plugin.handle(command, { shell, signal, workdir: config.workdir, session: command.session ?? null })
          : { ok: false, code: 'unknown_method', message: t('run.noPlugin', { method: command.method }) }
        await api.result(base, state.token, command.seq, outcome)
        state.cursor = command.seq
        saveConfig(config)
        presence?.sendAlive(state.cursor)
        const flag = outcome.ok ? t('run.ok') : t('run.error', { code: outcome.code ?? '' })
        print(t('run.command', { base, seq: command.seq, method: command.method, flag }))
      }
    } catch (error) {
      presence?.close()
      presence = null
      if (signal?.aborted) return
      if (error.code === 'unauthorized' || error.status === 401) {
        print(t('run.tokenRejected', { base }))
        state.token = null
        announced = false
        saveConfig(config)
        continue
      }
      print(t('run.retry', { base, message: error.message, seconds: Math.round(backoff / 1000) }))
      await pause(backoff)
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}
