/**
 * Мастер первичной настройки: `dshnc onboard`.
 *
 * Меню, а не поток вопросов, потому что настраивать приходится разное и в
 * разном порядке: кто-то пришёл за политикой доступа, кто-то за автозапуском.
 *
 * Главное правило: **текущее значение — предложение по умолчанию**, а пустой
 * ответ его сохраняет. Так мастер не ломает уже настроенный узел и не требует
 * вспоминать, что там было.
 *
 * @module dsh-node-client/onboard
 */

/** Ответ с подсказкой: пустой ввод оставляет прежнее значение. */
async function askDefault (ask, question, current) {
  const shown = current === null || current === undefined || current === ''
    ? question
    : `${question} [${current}]`
  const answer = (await ask(`${shown}: `) ?? '').trim()
  return answer === '' ? current : answer
}

/** Список через запятую ↔ массив. */
function toList (value) {
  if (Array.isArray(value)) return value
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

/**
 * Пункт меню «доступ»: имя, каталоги, режимы, кто отвечает на вопросы.
 *
 * @returns {Promise<object>} изменения, которые надо сохранить
 */
export async function askAccess ({ ask, config, policy }) {
  const patch = {}
  patch.name = await askDefault(ask, 'Имя узла', config.name ?? '')
  patch.aliases = toList(await askDefault(ask, 'Алиасы через запятую', toList(config.aliases).join(', ')))
  patch.workdir = await askDefault(ask, 'Каталог сессий (абсолютный путь)', config.workdir ?? '')
  const roots = await askDefault(ask, 'Разрешённые каталоги через запятую', toList(config.roots).join(', '))
  const modes = ['ro', 'rw', 'full']
  const max = await askDefault(ask, `Потолок прав (${modes.join('/')})`, policy?.max ?? 'rw')
  const base = await askDefault(ask, `Стартовый режим (${modes.join('/')})`, policy?.base ?? 'rw')
  const approver = await askDefault(ask, 'Кто отвечает на вопросы: local/server/none', policy?.approver ?? 'none')

  // каталоги живут в корне конфига, режимы и каналы — в политике: мастер
  // обязан писать их туда, где их читает клиент
  patch.roots = toList(roots)
  const next = { max, base, approver }
  if (approver === 'local') {
    const current = policy?.ask?.local?.tool?.command ?? ''
    const tool = await askDefault(ask, 'Команда вопроса (пусто — не спрашивать)', current)
    next.ask = tool
      ? { local: { enabled: true, tool: { type: 'external', command: tool } } }
      : { local: { enabled: false } }
  }
  patch.policy = { ...(config.policy ?? {}), ...next }
  return patch
}

/** Пункт меню «связь»: опрос и пинг по сокету. */
export async function askConnection ({ ask, config }) {
  return {
    pollIdleMs: Number(await askDefault(ask, 'Периодический опрос, мс (0 — только события)', config.pollIdleMs ?? 0)) || 0,
    pingInterval: Number(await askDefault(ask, 'Пинг по сокету, с (0 — выключен)', config.pingInterval ?? 0)) || 0,
    maxPingIntervalFactor: Number(await askDefault(ask, 'Во сколько раз растягивать пинг без работы (0 — не растягивать)', config.maxPingIntervalFactor ?? 0)) || 0,
  }
}

/** Показать, что получилось: перед записью человек должен увидеть итог. */
export function renderConfig (config) {
  const plain = { ...config }
  delete plain.servers
  delete plain.id
  return JSON.stringify(plain, null, 2)
}

/**
 * Цикл меню.
 *
 * @param {object} options
 * @param {(question: string) => Promise<string>} options.ask
 * @param {(text: string) => void} options.print
 * @param {() => object} options.load свежие настройки
 * @param {(patch: object) => object} options.save сохранить и вернуть итог
 * @param {(config: object) => Promise<void>} options.autostart запуск мастера автозапуска
 * @param {() => string[]} [options.status] строки состояния для шапки
 */
export async function runOnboard ({ ask, print, load, save, autostart, status = () => [] }) {
  for (;;) {
    const config = load()
    print('')
    for (const line of status(config)) print(line)
    print('')
    print('1) доступ: имя, каталоги, режимы, кто отвечает на вопросы')
    print('2) связь: опрос, пинг по сокету')
    print('3) автозапуск: systemd-юнит')
    print('4) показать конфиг')
    print('0) выход')
    const choice = (await ask('Что настроить? ') ?? '').trim()
    if (choice === '0' || choice === '') return

    if (choice === '1') {
      const patch = await askAccess({ ask, config, policy: config.policy ?? {} })
      // показываем итог ДО записи: предпросмотр не должен ничего сохранять
      print('')
      print('Итог:')
      print(renderConfig({ ...config, ...patch }))
      const ok = (await ask('Записать? [Y/n] ') ?? '').trim().toLowerCase()
      if (ok === '' || ok === 'y' || ok === 'да') {
        save(patch)
        print('сохранено')
      } else {
        print('не записано')
      }
      continue
    }

    if (choice === '2') {
      const patch = await askConnection({ ask, config })
      save(patch)
      print('сохранено')
      continue
    }

    if (choice === '3') {
      await autostart(load())
      continue
    }

    if (choice === '4') {
      print(renderConfig(load()))
      continue
    }

    print('нет такого пункта')
  }
}
