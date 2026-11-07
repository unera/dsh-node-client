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
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeUrl } from './config.mjs'
import { home, openStore } from './store.mjs'
import { openPresence } from './presence.mjs'
import { classify, DSH_MODES, MODES, narrower, profileArgs, probe } from './sandbox.mjs'
import { createSessionStore } from './sessions.mjs'
import { askLocally } from './approver.mjs'
import { apisOf, loadPlugins, resolvePlugin } from './plugins/index.mjs'
import { t } from './i18n.mjs'

/**
 * Пауза с уважением к отмене.
 *
 * Слушатель снимается в finally: демон живёт сутками и делает паузу раз в
 * несколько секунд. Иначе один AbortSignal копит тысячи слушателей — это и
 * предупреждение MaxListenersExceeded, и растущая память.
 */
/** Код возврата из результата команды: клиент кладёт его последним блоком. */
export function codeOf (outcome) {
  const blocks = Array.isArray(outcome?.results) ? outcome.results : []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = blocks[i]?.text
    if (typeof text !== 'string' || !text.startsWith('{')) continue
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.code === 'number') return parsed.code
    } catch {}
  }
  return null
}

/**
 * Исполнить пачку команд.
 *
 * `session.chdir` применяется первым и по порядку: он меняет каталог сессии, и
 * все остальные команды пачки должны стартовать уже в новом. Остальное идёт
 * параллельно, но с потолком: один ход модели может принести десяток вызовов, и
 * поднимать десяток процессов разом — плохая идея.
 *
 * @param {object[]} commands команды из выдачи
 * @param {object} options
 * @param {(command: object) => Promise<object>} options.run исполнить одну
 * @param {number} [options.concurrency]
 */
export async function runConcurrently (commands, run, { concurrency = 5 } = {}) {
  const queue = [...commands]
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const command = queue.shift()
      if (!command) return
      try {
        await run(command)
      } catch {
        // одна упавшая команда не должна утащить за собой всю пачку: иначе
        // остальные останутся `processing` и сервер сочтёт их потерянными
      }
    }
  })
  await Promise.all(workers)
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    signal?.removeEventListener?.('abort', onAbort)
    resolve()
  }, ms)
  const onAbort = () => {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
    reject(new Error('aborted'))
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
})

/**
 * Подключение по ссылке с кодом: подтверждать нечего, код всё связывает сам.
 * @returns {Promise<object>} запись сервера с токеном
 */
/**
 * Сохранить рантайм сервера: курсор и прочее — в state.sqlite, токен — в
 * credentials.yaml. В config.json не пишем ничего: там только настройки.
 */
function persist (store, url, state) {
  store.writeState(url, {
    cursor: state.cursor ?? null,
    epoch: state.epoch ?? null,
    boot: state.boot ?? null,
    node: state.node ?? null,
    alias: state.alias ?? null,
    apiIds: state.apiIds ?? {},
  })
  if ('token' in state) store.setToken(url, state.token ?? null)
}

/**
 * Песочница для одной команды.
 *
 * Режим приходит от сервера (`sandbox.mode`), но владелец узла ограничивает его
 * сверху через `config.max`: эффективный режим — более узкий из двух. Каталог
 * сессии становится рабочим каталогом команды, а в режиме `rw` — единственным
 * местом, куда вообще можно писать (плюс `/tmp`).
 *
 * @param {object} config настройки узла
 * @param {object} command команда из очереди
 * @param {object} sessions хранилище каталогов сессий
 * @returns {object|null} описание песочницы или null, если команда вне песочницы
 */
/** Правила узла для конкретного сервера: policy[url] поверх общих настроек. */
export function policyFor (config, url) {
  const common = {
    max: config.access?.max ?? 'rw',
    roots: config.roots ?? null,
    workdir: config.workdir ?? null,
    maxConcurrent: config.maxConcurrent ?? 5,
    // режим, в котором команда стартует: `full` = не понижать (как было раньше)
    base: config.access?.base ?? 'full',
    approver: config.access?.approver ?? 'none',
    approvalTtlSeconds: config.approvalTtlSeconds ?? 86400,
    // `ask` — каналы (web/local). Это не то же, что «разрешено ли спрашивать»:
    // булево для сервера считается из approver, см. askEnabled ниже.
    ask: config.ask ?? null,
  }
  const own = url ? config.policy?.[url] ?? {} : {}
  return { ...common, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined && value !== null)) }
}

/**
 * Разрешено ли серверу спрашивать человека на этом узле.
 *
 * В протокол уходит именно булево (`allowEscalation`), а `approver` описывает
 * канал: `local` — спрашиваем на машине, `server` — через DSH, `none` — никогда.
 *
 * @param {object} policy правила узла
 * @returns {boolean}
 */
export function askEnabled (policy) {
  return policy?.approver === 'local' || policy?.approver === 'server'
}

/**
 * Команда локального апрува из настроек узла.
 *
 * `ask.local.enabled: false` или пустой шаблон означают «спросить некого» — тогда
 * плагин вернёт `no_local_approver`, и сервер не будет делать вид, что вопрос
 * задан.
 *
 * @param {object} config настройки клиента
 * @returns {string|null}
 */
export function askLocalCommand (policy) {
  const local = policy?.ask?.local
  if (!local?.enabled) return null
  const command = local.tool?.command
  return typeof command === 'string' && command.trim() ? command.trim() : null
}

export function sandboxFor (config, command, sessions, url) {
  const policy = policyFor(config, url)
  const requested = MODES.includes(command.sandbox?.mode) ? command.sandbox.mode : policy.max
  // потолок узла режет запрошенное всегда
  const want = narrower(requested, policy.max)
  // `base` — это «в каком режиме стартуем», но подтверждённую человеком команду
  // понижать нельзя: иначе апрув ничего не значит
  const approved = Boolean(command.approved)
  const mode = approved || policy.approver === 'none' ? want : narrower(want, policy.base)
  let cwd = null
  if (command.session && sessions) {
    try {
      cwd = sessions.cwd(command.session, { workdir: policy.workdir, roots: policy.roots })
    } catch {
      cwd = policy.workdir ?? null
    }
  } else {
    cwd = policy.workdir ?? null
  }
  const workdir = policy.workdir ? canonicalWorkdir(policy.workdir) : null
  const roots = policy.roots?.length ? policy.roots : (workdir ? [workdir] : ['/'])
  return {
    mode,
    dshMode: DSH_MODES[mode],
    order: config.access?.order ?? [],
    args: profileArgs({ mode, workdir, writable: roots, cwd }),
    cwd,
    probe,
    classify,
  }
}

function canonicalWorkdir (workdir) {
  try {
    return realpathSync(workdir)
  } catch {
    return workdir
  }
}

export async function pairServer ({ url, config, print }) {
  const { base, code } = api.parseConnectUrl(url)
  if (!code) throw new Error(t('connect.noCode'))
  const store = openStore()
  const state = { ...store.readState(base), token: store.token(base) }
  const response = await api.pair(base, { code, uuid: config.id, name: config.name, aliases: config.aliases })
  state.token = response.body.token
  state.cursor = 0
  state.epoch = null
  state.alias = response.body.alias ?? null
  state.node = response.body.node ?? null
  delete state.announced
  persist(store, base, state)
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
  const store = openStore()
  const state = { ...store.readState(base), token: store.token(base) }
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
        await api.enroll(base, { uuid, name: config.name, aliases: config.aliases, nonce: store.clientNonce() })
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
      const response = await api.enrollStatus(base, uuid, store.clientNonce())
      if (response.status === 200 && response.body?.token) {
        state.token = response.body.token
        state.cursor = 0
        state.epoch = null
        state.alias = response.body.alias ?? null
        state.node = response.body.node ?? null
        delete state.announced
        persist(store, base, state)
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
  const store = openStore()
  const state = { ...store.readState(base), token: store.token(base) }
  const sessions = createSessionStore(store)
  const loaded = plugins ?? await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => print(message) })
  /**
   * Активные диалоги апрува. Живут отдельно от пачки: их не ждут, но при смене
   * эпохи (сервер перезапустился, очередь пуста) их надо закрыть — иначе человек
   * увидит вопрос, на который уже некому ответить.
   */
  const pendingApprovals = new Map()
  let reloadRequested = false
  // SIGHUP читает конфиг заново и будит цикл: без пробуждения reload оставался
  // бы «принятым», но не применённым — цикл спит до кадра от сервера
  const onHup = () => {
    reloadRequested = true
    wake?.()
  }
  process.on('SIGHUP', onHup)
  let backoff = 1000
  // SIGHUP меняет config на месте и ставит отметку: по ней понимаем, что пора
  // переобъявить API и пересоздать сокет с новыми правилами
  let reloadToken = config.reloadToken ?? null
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
  /**
   * Ждать кадр без таймера.
   *
   * Единственный способ проснуться — уведомление от сокета или остановка
   * демона. Если сокет умрёт молча, клиент так и будет спать: это цена
   * событийной схемы, и она приемлема, пока страховочный опрос выключен.
   */
  const waitForWake = () => new Promise((resolve) => {
    wake = resolve
    signal?.addEventListener?.('abort', () => {
      wake = null
      resolve()
    }, { once: true })
  })

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
      if (reloadRequested) {
        reloadRequested = false
        print(t('daemon.reload'))
        const fresh = openStore().settings ?? {}
        for (const key of Object.keys(config)) delete config[key]
        Object.assign(config, fresh)
        // новые правила должны доехать до сервера: переобъявляем и пересоздаём
        // сокет, иначе изменившиеся base/approver/ping останутся на бумаге
        announced = false
        presence?.close()
        presence = null
      }
      if ((config.reloadToken ?? null) !== reloadToken) {
        reloadToken = config.reloadToken ?? null
        // политика, права и каналы вопросов могли измениться: объявляем заново,
        // сокет пересоздаём — иначе новые pingInterval/approver не подхватятся
        announced = false
        presence?.close()
        presence = null
      }
      // демон без токена сам идёт в заявку и ждёт одобрения: тогда из админки
      // связь появляется сама, без перезапуска клиента
      if (!state.token) {
        await enrollServer({ url: base, config, print, signal, forever: true })
        // заявку одобрили в другом вызове: перечитываем состояние, иначе
        // дальше пойдём со старым пустым токеном и получим 401
        Object.assign(state, store.readState(base), { token: store.token(base) })
      }
      if (!announced) {
        const response = await api.announce(base, state.token, apisOf(loaded), {
          workdir: config.workdir ?? null,
          access: policyFor(config, base).max,
          allowEscalation: askEnabled(policyFor(config, base)),
          uptimeSeconds: process.uptime(),
          approver: policyFor(config, base).approver,
          startMode: policyFor(config, base).base,
          // прикладной пинг: 0 — выключен, factor — потолок растяжения
          pingInterval: config.pingInterval ?? 0,
          maxPingIntervalFactor: config.maxPingIntervalFactor ?? 0,
        })
        announced = true
        state.epoch = response.body.epoch ?? null
        state.apiIds = {}
        for (const entry of response.body.apis ?? []) state.apiIds[entry.name] = entry.id
        persist(store, base, state)
        const names = (response.body.apis ?? []).map((entry) => `${entry.name}#${entry.id}`).join(', ')
        print(t('run.announced', { base, apis: names, epoch: state.epoch }))
        for (const warning of response.body.warnings ?? []) print(t('run.warning', { warning }))
      }

      if (!presence) presence = openPresence({
        workdir: policyFor(config, base).workdir ?? config.workdir ?? null,
        access: policyFor(config, base).max,
        allowEscalation: askEnabled(policyFor(config, base)),
        // время старта процесса: сервер посчитает аптайм по своему clock
        uptimeSeconds: process.uptime(),
        approver: policyFor(config, base).approver,
        // `base` — стартовый режим: сервер покажет его в панели рядом с потолком.
        // В presence параметр назван startMode, чтобы не спорить с именем url-базы
        startMode: policyFor(config, base).base,
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
              persist(store, base, state)
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
        state.cursor = null
        // диалоги прошлой жизни: сервер их уже не помнит, ответить некому
        for (const controller of pendingApprovals.values()) controller.abort()
        pendingApprovals.clear()
        persist(store, base, state)
      }

      /**
       * Контекст для плагина: каталог сессии, корни из правил сервера и песочница.
       * Считается на каждую команду — политика и каталог могут отличаться.
       */
      const pluginContext = (command) => {
        const policy = policyFor(config, base)
        return {
          shell,
          // у диалога апрува свой сигнал: его отменяют отдельно от всего цикла
          signal: command.signal ?? signal,
          workdir: policy.workdir ?? config.workdir,
          roots: policy.roots?.length ? policy.roots : (policy.workdir ? [policy.workdir] : ['/']),
          // `files` не должен получать «/» как разрешение на всё: пустой список
          // означает «каталоги не настроены», и это отказ, а не свобода
          fileRoots: policy.roots?.length ? policy.roots : (policy.workdir ? [policy.workdir] : []),
          session: command.session ?? null,
          sessions,
          approver: {
            command: askLocalCommand(policyFor(config, base)),
            run: (options) => askLocally({ ...options, timeout: options.timeout ?? config.approvalTtlSeconds ?? 86400 }),
          },
          sandbox: sandboxFor(config, command, sessions, base),
        }
      }

      /**
       * Исполнить одну команду и отчитаться. Вынесено, чтобы пачка могла идти
       * параллельно, а отчёт по каждой команде оставался прежним.
       */
      const executeOne = async (command) => {
        const ctx = pluginContext(command)
        const plugin = resolvePlugin(loaded, command, state.apiIds ?? {})
        const outcome = plugin
          ? await plugin.handle(command, ctx)
          : { ok: false, code: 'unknown_method', message: t('run.noPlugin', { method: command.method }) }
        try {
          await api.result(base, state.token, command.seq, outcome)
        } catch (error) {
          print(t('run.resultFailed', { seq: command.seq, message: error.message }))
        }
        // режим full ничего не ограничивает, поэтому оставляем след
        if (plugin && ctx.sandbox?.mode === 'full') {
          try {
            store.writeAudit({
              session: command.session ?? null,
              mode: 'full',
              command: typeof command.args?.command === 'string' ? command.args.command : JSON.stringify(command.args ?? {}),
              code: codeOf(outcome),
              at: Date.now(),
            })
          } catch (error) {
            print(t('run.auditFailed', { message: error.message }))
          }
        }
        const flag = outcome.ok ? t('run.ok') : t('run.error', { code: outcome.code ?? '' })
        print(t('run.command', { base, seq: command.seq, method: command.method, flag }))
      }

      /**
       * Пачка: сначала `session.chdir` по порядку (он меняет каталог сессии, и
       * остальные команды должны стартовать уже в новом), затем остальное
       * параллельно с потолком.
       */
      const runBatch = async (batch) => {
        // `chdir` меняет каталог сессии, поэтому он первый и по порядку:
        // остальные команды пачки должны стартовать уже в новом каталоге
        for (const command of batch.filter((cmd) => cmd.method === 'chdir')) await executeOne(command)

        // `approve` — это диалог с человеком, он может висеть сутки. Держать им
        // слот пула нельзя: иначе пачка не закроется и опрос встанет
        for (const command of batch.filter((cmd) => cmd.method === 'approve')) {
          const controller = new AbortController()
          pendingApprovals.set(command.seq, controller)
          void executeOne({ ...command, signal: controller.signal })
            .catch(() => {})
            .finally(() => pendingApprovals.delete(command.seq))
        }

        const rest = batch.filter((cmd) => cmd.method !== 'chdir' && cmd.method !== 'approve')
        // потолок одновременных процессов: один ход модели может принести
        // десяток вызовов, и заваливать узел нагрузкой нельзя
        await runConcurrently(rest, executeOne, { concurrency: policyFor(config, base).maxConcurrent ?? 5 })
      }

      const response = await api.commands(base, state.token, { limit: config.batch ?? 5 })
      presence?.noteSeen?.()
      const commands = response.body.commands ?? []
      if (state.epoch !== response.body.epoch) {
        state.epoch = response.body.epoch
        state.cursor = null
      }
      // `known` — до какого номера я в курсе. Сервер отдаёт `state` (последний
      // выданный номер), но опираться на него нельзя: между выдачами он растёт.
      // Поэтому помним максимум из полученных команд — это ровно то, что
      // спрашивается в `check_state`.
      for (const command of commands) {
        if (Number.isFinite(command.seq) && (state.cursor == null || command.seq > state.cursor)) state.cursor = command.seq
      }
      persist(store, base, state)
      presence?.sendAlive(state.cursor ?? null)

      if (!commands.length) {
        // Периодического опроса нет вовсе: `pollIdleMs: 0` выключает его
        // полностью, и тогда единственный повод проснуться — кадр от сервера
        // или восстановление сокета. Ненулевое значение оставляет страховку.
        const idlePoll = config.pollIdleMs ?? pollIdleMs
        if (!idlePoll) {
          await waitForWake()
          continue
        }
        await pause(presence?.online?.() ? (config.pollFallbackMs ?? idlePoll) : idlePoll)
        continue
      }
      backoff = 1000
      presence?.noteCommands?.()
      await runBatch(commands)
      presence?.sendAlive(state.cursor ?? null)
    } catch (error) {
      presence?.close()
      presence = null
      if (signal?.aborted) return
      if (error.code === 'unauthorized' || error.status === 401) {
        print(t('run.tokenRejected', { base }))
        state.token = null
        announced = false
        persist(store, base, state)
        continue
      }
      print(t('run.retry', { base, message: error.message, seconds: Math.round(backoff / 1000) }))
      await pause(backoff)
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}
