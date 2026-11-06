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
import { normalizeUrl, serverState, saveConfig } from './config.mjs'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener?.('abort', () => {
    clearTimeout(timer)
    reject(new Error('aborted'))
  }, { once: true })
})

/**
 * Первичная регистрация: заявка и ожидание одобрения человеком.
 * @param {object} options
 * @param {string} options.url
 * @param {object} options.config
 * @param {(line: string) => void} options.print
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<object>} запись сервера с токеном
 */
export async function enrollServer ({ url, config, print, signal }) {
  const base = normalizeUrl(url)
  const state = serverState(config, base)
  const uuid = config.id
  await api.enroll(base, { uuid, name: config.name })
  print(`заявка отправлена: ${config.name} / ${uuid.slice(0, 8)}`)
  print(`админ должен допустить её в ${base}/admin — ждём`)
  for (let attempt = 0; attempt < 360; attempt++) {
    if (signal?.aborted) throw new Error('aborted')
    const response = await api.enrollStatus(base, uuid)
    if (response.status === 200 && response.body?.token) {
      state.token = response.body.token
      state.cursor = 0
      state.epoch = null
      state.alias = response.body.alias ?? null
      state.node = response.body.node ?? null
      saveConfig(config)
      print(`допущен: узел ${response.body.node ?? '?'} (${response.body.alias ?? 'без алиаса'}), токен сохранён`)
      return state
    }
    if (response.body?.status === 'rejected') throw new Error('заявку отклонили')
    if (response.body?.status === 'handed') throw new Error('токен уже выдан; перевыпусти в админке')
    await sleep(2000, signal)
  }
  throw new Error('заявка не одобрена за 30 минут')
}

/**
 * Цикл одного сервера. Возвращается только по отмене или фатальной ошибке.
 */
export async function runServer ({ url, config, print, signal, shell, pollIdleMs = 5000 }) {
  const base = normalizeUrl(url)
  const state = serverState(config, base)
  let backoff = 1000

  while (!signal?.aborted) {
    try {
      if (!state.token) await enrollServer({ url: base, config, print, signal })
      if (!state.announced) {
        const response = await api.announce(base, state.token, [api.bashApi({ shell })])
        state.announced = true
        state.epoch = response.body.epoch ?? null
        saveConfig(config)
        print(`${base}: объявили bash, apis ${JSON.stringify(response.body.apis)}, epoch ${state.epoch}`)
        for (const warning of response.body.warnings ?? []) print(`предупреждение: ${warning}`)
      }

      // сверка поколений: несовпадение = реконнект, курсор в ноль (§4.7)
      const current = await api.state(base, state.token)
      if (state.epoch != null && current.body.epoch !== state.epoch) {
        print(`${base}: сервер перезапущен (epoch ${state.epoch} → ${current.body.epoch}), курсор сброшен`)
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
        await sleep(pollIdleMs, signal)
        continue
      }
      backoff = 1000
      for (const command of commands) {
        const outcome = await execute(command, { shell, signal })
        await api.result(base, state.token, command.seq, outcome)
        state.cursor = command.seq
        saveConfig(config)
        const flag = outcome.ok ? 'ok' : `error ${outcome.code ?? ''}`
        print(`${base}: ${command.seq} ${command.method} → ${flag}`)
      }
    } catch (error) {
      if (signal?.aborted) return
      if (error.code === 'unauthorized' || error.status === 401) {
        print(`${base}: токен не подошёл, нужна новая заявка`)
        state.token = null
        state.announced = false
        saveConfig(config)
        continue
      }
      print(`${base}: ${error.message} — повтор через ${Math.round(backoff / 1000)} с`)
      await sleep(backoff, signal).catch(() => {})
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

/** Один вызов: маршрутизация по имени API и метода. */
async function execute (command, { shell, signal }) {
  const method = command.method
  const args = command.args ?? {}
  if (command.api === 1 || command.sandbox !== undefined || true) {
    if (method === 'exec') {
      return runBash({ command: args.command, cwd: args.cwd, timeout: command.timeout ?? args.timeout, shell, signal })
    }
  }
  return { ok: false, code: 'unknown_method', message: `клиент не знает метода ${method}` }
}
