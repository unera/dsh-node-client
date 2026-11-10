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
import { preciseNow } from './shell.mjs'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeUrl } from './config.mjs'
import { home, openStore } from './store.mjs'
import { openPresence } from './presence.mjs'
import { classify, DSH_MODES, MODES, narrower, profileArgs, probe } from './sandbox.mjs'
import { createSessionStore } from './sessions.mjs'
import { askLocally } from './approver.mjs'
import { apisOf, loadPlugins, resolvePlugin, rulesOf } from './plugins/index.mjs'
import { forgetRunning, registerRunning } from './running.mjs'
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
 * Пул исполнителей с потолком одновременных команд.
 *
 * Почему пул, а не «пачка + Promise.all»: пока клиент ждёт всю пачку, он не
 * забирает новые команды, и `#INTERNAL.CANCEL`, поставленный сервером посреди
 * долгой команды, стоит в очереди до её конца — отменять некем.
 *
 * Пул отвечает на три вопроса: сколько слотов занято (`busy`) и свободно
 * (`free`), когда освободится хотя бы один (`whenFree`) и когда опустеет весь
 * (`whenIdle`). Последний нужен барьеру `#INTERNAL.FLUSH`: его смысл — «всё,
 * что было до меня, закончилось».
 *
 * @param {{slots?: number, run: (command: object) => Promise<unknown>}} options
 */
/**
 * Принять номер, который назвал сервер.
 *
 * `known` — не «максимум полученных номеров», а «до какого номера я в курсе».
 * Номера честный автоинкремент и не переиспользуются, поэтому номер от сервера
 * закрывает и дырки: отменённая команда номер израсходовала, но клиенту не
 * достанется никогда, и догнать её максимумом по полученным нельзя.
 *
 * @param {number|null|undefined} current что клиент знал раньше
 * @param {unknown} value `max_commandno` из ответа или кадра
 * @returns {number} новое знание (не меньше прежнего)
 */
export function adoptMaxCommandno (current, value) {
  const known = Number.isFinite(Number(current)) ? Number(current) : 0
  const named = Number(value)
  if (!Number.isFinite(named)) return known
  return Math.max(known, named)
}

export function createPool ({ slots = 5, run }) {
  const limit = Math.max(1, Number(slots) || 1)
  const active = new Set()
  const queue = []
  const idleWaiters = new Set()
  let busy = 0

  const start = (command) => {
    busy += 1
    const task = Promise.resolve()
      .then(() => run(command))
      .catch(() => {})
      .finally(() => {
        active.delete(task)
        busy -= 1
        pump()
        // будим всех ждущих: каждый сам проверит, хватает ли ему освободившегося
        // (барьер ждёт всех, кроме себя, поэтому условие «busy === 0» не годится).
        // Сам себя из набора убирает только тот, чьё условие выполнилось:
        // `clear()` здесь снял бы ожидание тех, кому ещё рано.
        for (const waiter of [...idleWaiters]) waiter()
      })
    active.add(task)
    return task
  }

  // всё, что не влезло в слоты, ждёт здесь и стартует в порядке выдачи
  const pump = () => {
    while (queue.length && busy < limit) {
      const item = queue.shift()
      item.resolve(start(item.command))
    }
  }

  return {
    get busy () { return busy },
    get free () { return Math.max(0, limit - busy) },
    get queued () { return queue.length },
    /**
     * Исполнить команду, заняв слот. Если слотов нет — команда ждёт здесь
     * (вызывающий и так не берёт у сервера больше, чем влезает, так что очередь
     * короткая и по делу).
     */
    submit (command) {
      if (busy < limit && queue.length === 0) return start(command)
      return new Promise((resolve) => { queue.push({ command, resolve }) })
    },
    /** Дождаться, пока освободится хотя бы один слот. */
    whenFree () {
      return active.size ? Promise.race([...active]) : Promise.resolve()
    },
    /** Дождаться пустого пула: ни в работе, ни в очереди. */
    /**
     * Дождаться пустого пула — с оговоркой: `reserve` занятых слотов считаются
     * «своими». Барьер `#INTERNAL.FLUSH` занимает слот как обычная команда, и
     * ждать ему нужно всех, **кроме себя**: иначе он ждёт сам себя, и узел
     * встаёт до серверного таймаута барьера.
     *
     * @param {number} [reserve] сколько занятых слотов считать своими
     */
    whenIdle (reserve = 0) {
      const done = () => busy <= reserve && queue.length === 0
      return done()
        ? Promise.resolve()
        : new Promise((resolve) => {
          // ждём события и перепроверяем: «освободился слот» и «пул пуст для
          // меня» — разные условия
          const waiter = () => {
            if (!done()) return
            idleWaiters.delete(waiter)
            resolve()
          }
          idleWaiters.add(waiter)
        })
    },
  }
}

/**
 * Ворота «проснись».
 *
 * Кадр от сервера будит цикл, но кадр, пришедший за миг ДО ожидания, не должен
 * теряться. Иначе получается мёртвый лок: сервер ответил `state` сразу после
 * нашего `check_state`, цикл в этот момент ещё не подписался на пробуждение,
 * кадр ушёл в никуда — а сервер считает, что разбудит клиента следующим кадром,
 * которого может не быть вовсе (работа уже лежит в очереди).
 *
 * Поэтому `nudge()` запоминает событие: следующий `wait()` вернётся сразу.
 */
export function createWakeGate () {
  let pending = false
  let waiter = null
  return {
    /** Пришло событие. */
    nudge () {
      pending = true
      const resolve = waiter
      waiter = null
      resolve?.()
    },
    /** Событие уже было и ещё не использовано — ждать нечего. */
    take () {
      if (!pending) return false
      pending = false
      return true
    },
    /** Ждать события (без таймера). */
    wait () {
      return new Promise((resolve) => { waiter = resolve })
    },
  }
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
export async function runServer ({ url, config, print, signal, shell, pollIdleMs = 0, plugins = null }) {
  const base = normalizeUrl(url)
  const store = openStore()
  // Свежий процесс не помнит, что было выдано прошлой жизни: взятые команды
  // умерли вместе с ним. Поэтому «знаю до» объявляем пустым — сервер по
  // `known: null` закроет свои висящие команды как node_restarted и не будет
  // держать из-за них очередь (на живой проверке висящий барьер заблокировал
  // узел на полчаса).
  const state = { ...store.readState(base), token: store.token(base), cursor: null }
  const sessions = createSessionStore(store)
  const loaded = plugins ?? await loadPlugins({ dir: join(home(), 'plugins'), log: (level, message) => print(message) })
  let reloadRequested = false
  // SIGHUP читает конфиг заново и будит цикл: без пробуждения reload оставался
  // бы «принятым», но не применённым — цикл спит до кадра от сервера
  const onHup = () => {
    reloadRequested = true
    nudge()
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
  const gate = createWakeGate()
  /** Разбудить цикл: пришёл кадр `state`, опрос ждать не надо. */
  const nudge = () => gate.nudge()
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
    // кадр мог прийти между отправкой check_state и этим ожиданием
    if (gate.take()) return resolve()
    signal?.addEventListener?.('abort', () => resolve(), { once: true })
    gate.wait().then(() => { gate.take(); resolve() })
  })

  const pause = (ms) => new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    if (gate.take()) return done()
    signal?.addEventListener?.('abort', done, { once: true })
    gate.wait().then(() => { gate.take(); done() })
  })

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
        // передача файлов ходит по HTTP на тот же сервер, чей сокет держим
        server: base,
        token: state.token,
        approver: {
          command: askLocalCommand(policyFor(config, base)),
          run: (options) => askLocally({ ...options, timeout: options.timeout ?? config.approvalTtlSeconds ?? 86400 }),
        },
        sandbox: sandboxFor(config, command, sessions, base),
        // барьер `#INTERNAL.FLUSH` ждёт этим: пул пуст — значит всё, что было
        // до него, действительно закончилось
        // барьер занимает слот сам, поэтому ждём «всех, кроме себя»:
        drain: () => pool.whenIdle(1),
      }
    }

    /**
     * Пул исполнителей: потолок одновременных команд из настроек узла.
     * `approve` в пул не входит — диалог с человеком может висеть сутки.
     */
    const pool = createPool({
      slots: policyFor(config, base).maxConcurrent ?? 5,
      run: (command) => executeOne(command),
    })

    /**
     * Исполнить одну команду и отчитаться. Вынесено, чтобы пачка могла идти
     * параллельно, а отчёт по каждой команде оставался прежним.
     */
    const executeOne = async (command) => {
      const ctx = pluginContext(command)
      const plugin = resolvePlugin(loaded, command, state.apiIds ?? {})
      // служебная команда и диалог апрува пул не занимают: барьер не должен
      // ждать сам себя, а апрув — тем более
      const isControl = String(command.method).startsWith('#')
      try {
        const outcome = plugin
          ? (typeof plugin.handleControl === 'function' && isControl
            ? await plugin.handleControl(command, ctx)
            : await plugin.handle(command, ctx))
          : { ok: false, code: 'unknown_method', message: t('run.noPlugin', { method: command.method }) }
        try {
          // `now` — свои часы в конверте: по ним правило timing считает
          // смещение. Это не знание о правилах, а простой факт об ответе
          const delivered = await api.result(base, state.token, command.seq, { ...outcome, now: preciseNow() })
          // сервер закрыл команду раньше нас (таймаут, аборт): результат
          // отдавать некому. Это не ошибка, но и молчать не надо — иначе
          // непонятно, куда делся ответ
          if (delivered?.body?.late) {
            print(t('run.orphanResult', { seq: command.seq, method: command.method }))
          }
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
      } catch (error) {
        // падение обработчика не должно оставить команду без ответа: сервер
        // тогда ждёт её таймаут и считает результат потерянным
        print(t('run.command', { base, seq: command.seq, method: command.method, flag: t('run.error', { code: 'client_error' }) }))
        await api.result(base, state.token, command.seq, {
          ok: false,
          code: 'client_error',
          message: error?.message ?? String(error),
        }).catch(() => {})
      }
    }

    /**
     * Запустить пачку, не дожидаясь её целиком.
     *
     * Особых дорожек больше нет: и работа, и служебные команды (включая вопрос
     * человеку) идут через пул, а различаются только приоритетом в очереди
     * сервера. `chdir` тоже не привилегирован — за порядок отвечает правило
     * `flushAround`: барьер выдаёт его одному, до и после пустого пула.
     *
     * Команды не ждём: цикл должен вернуться к выборке, иначе, пока идёт долгая
     * команда, клиент не заберёт `#INTERNAL.CANCEL`, и отменить её будет нечем.
     */
    const startBatch = (batch) => {
      for (const command of batch) void pool.submit(command)
    }

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
          applyRules: rulesOf(loaded),
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
        // номер соединения: по нему сервер решает, кого оставить, если клиент
        // случайно поднялся дважды
        conn: store.nextConn(base),
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
          if (event.type === 'state') {
            // кадр несёт номер: принимаем его как свой, иначе дырка в
            // нумерации (отменённая команда) не даст нам догнать сервер
            // номер из кадра не усыновляем: он значит «у сервера больше», а не
            // «клиент всё взял». Примем его, когда очередь опустеет
            nudge()
          }
          if (event.type === 'closed') {
            // 4001 — соединение вытеснено новым, 4409 — оно устарело.
            // В обоих случаях этот экземпляр лишний: уходим, чтобы не
            // осталось два клиента, выхватывающих команды друг у друга.
            if (event.code === 4001 || event.code === 4409) {
              print(t('run.presenceReplaced', { base, code: event.code }))
              signal?.abort?.()
              // нулевой код: это не сбой, а нормальное «я лишний». Служба
              // с Restart=on-failure такой выход не перезапускает.
              setTimeout(() => process.exit(0), 50)
            }
            print(t('run.presenceClosed', { base, code: event.code }))
            presence = null
            // пауза перед новой попыткой: без неё при недоступном сервере
            // получается плотный цикл соединений
            setTimeout(nudge, 1000)
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
        abortAllApprovals()
        persist(store, base, state)
      }

      // берём не больше, чем влезает в свободные слоты: выданное сервером уже
      // считается выданным, и «лишнее» висело бы у нас непонятно где
      const batchLimit = Math.max(1, Math.min(Number(config.batch) || 5, pool.free || 1))
      const response = await api.commands(base, state.token, { limit: batchLimit })
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
        // Опрос — только если человек сам его включил в настройках:
        // по умолчанию узел просыпается исключительно кадром сервера.
        // Очередь выработана — только теперь можно принять номер сервера
        // целиком. Принимать его раньше нельзя: в очереди ещё могут стоять
        // команды с меньшими номерами, и «я знаю до N» оставило бы их нам
        // недоставленными (так и вышло на живой проверке 0.0.91).
        state.cursor = adoptMaxCommandno(state.cursor, response.body.max_commandno)
        persist(store, base, state)

        const idlePoll = config.pollIdleMs ?? pollIdleMs
        if (!idlePoll) {
          // Подписка ДО вопроса, а не после. В websocket у нас не события, а
          // состояние: сервер отвечает кадром `state` ровно в тот миг, когда
          // видит `state > known`. Если сначала спросить, а потом подписаться,
          // ответ может прийти в этот промежуток и упасть в пустоту — а
          // повторно никто не спросит, и узел уснёт с лежащей в очереди работой.
          const sleeping = waitForWake()
          presence?.sendAlive(state.cursor ?? null)
          await sleeping
          continue
        }
        await pause(presence?.online?.() ? (config.pollFallbackMs ?? idlePoll) : idlePoll)
        continue
      }
      backoff = 1000
      presence?.noteCommands?.()
      await startBatch(commands)
      presence?.sendAlive(state.cursor ?? null)
      // слоты кончились — ждём, пока освободится хотя бы один, и сразу идём
      // забирать дальше: очередь сервера не должна ждать конца долгой команды
      if (pool.free === 0) await pool.whenFree()
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
