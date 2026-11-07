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

/**
 * Взять правила того сервера, к которому узел подключён.
 *
 * Политика хранится по адресам серверов, поэтому «текущий потолок» — это не
 * `config.policy`, а `config.policy[url]`. Если серверов несколько, берём
 * первый: мастер правит один узел за раз, а переносить правила между серверами
 * он не умеет и не должен делать вид, что умеет.
 *
 * @param {object} config настройки клиента
 * @returns {{url: string|null, policy: object}}
 */
export function pickPolicy (config) {
  const entries = Object.entries(config?.policy ?? {})
  if (!entries.length) return { url: null, policy: {} }
  const [url, policy] = entries[0]
  return { url, policy: policy ?? {} }
}

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
export async function askAccess ({ ask, print = () => {}, config, policy, url = null }) {
  const patch = {}
  // Мастер не просто спрашивает — он объясняет, что означает каждый ответ.
  // Без этого человек отвечает «наугад», а потом не понимает, почему узел
  // отказывает в записи или не задаёт вопросы.
  print('Имя узла — это то, чем узел зовут в вызовах и что видно в админке.')
  patch.name = await askDefault(ask, 'Имя узла', config.name ?? '')
  patch.aliases = toList(await askDefault(ask, 'Алиасы через запятую', toList(config.aliases).join(', ')))
  print('Каталог сессий — где клиент заводит рабочие каталоги для моделей.')
  // каталоги клиент читает из политики сервера, если они там заданы, поэтому
  // по умолчанию подставляем именно их, а не пустой корень конфига
  const workdir = await askDefault(ask, 'Каталог сессий (абсолютный путь)', policy?.workdir ?? config.workdir ?? '')
  print('Разрешённые каталоги — границы записи: всё вне них узлу недоступно на запись.')
  const roots = await askDefault(
    ask,
    'Разрешённые каталоги через запятую',
    toList(policy?.roots ?? config.roots).join(', '),
  )
  const modes = ['ro', 'rw', 'full']
  print('Потолок прав — самый широкий режим, который узел разрешит вообще:')
  print('  ro — только чтение, rw — запись внутри разрешённых каталогов, full — без песочницы.')
  const max = await askDefault(ask, `Потолок прав (${modes.join('/')})`, policy?.max ?? 'rw')
  print('Стартовый режим — в каком режиме команда запускается по умолчанию.')
  print('  Он может быть уже потолка: тогда расширение требует разрешения человека.')
  const base = await askDefault(ask, `Стартовый режим (${modes.join('/')})`, policy?.base ?? 'rw')
  print('Кто отвечает на вопрос «разрешить шире?»:')
  print('  local — человек за этой машиной (окно на узле), server — человек в DSH, none — не спрашивать.')
  const approver = await askDefault(ask, 'Кто отвечает на вопросы: local/server/none', policy?.approver ?? 'none')

  // и каталоги, и режимы пишем в раздел этого сервера: раннер собирает общие
  // значения из корня и накрывает их политикой сервера, поэтому корень без
  // политики выглядел бы «настроил и не работает»
  const next = { max, base, approver, roots: toList(roots), workdir }
  if (approver === 'local') {
    const current = policy?.ask?.local?.tool?.command ?? ''
    print('Команда вопроса — чем на этой машине спросить человека. Подойдёт любой')
    print('  инструмент, который возвращает 0 на «да»:')
    print('    zenity --text-info --width=600 --title=dsh-nodes')
    print('    kdialog --textinputbox "dsh-nodes"')
    print('    notify-send ... && свой скрипт, который ждёт ответа')
    print('  Текст вопроса уходит в stdin, если в команде нет %s.')
    const tool = await askDefault(ask, 'Команда вопроса (пусто — не спрашивать)', current)
    next.ask = tool
      ? { local: { enabled: true, tool: { type: 'external', command: tool } } }
      : { local: { enabled: false } }
  }
  // правила пишем в тот сервер, который настраиваем: иначе они окажутся нигде
  patch.policy = url
    ? { ...(config.policy ?? {}), [url]: { ...(config.policy?.[url] ?? {}), ...next } }
    : (config.policy ?? {})
  return patch
}

/** Пункт меню «связь»: опрос и пинг по сокету. */
export async function askConnection ({ ask, print = () => {}, config }) {
  // Для новой настройки предлагаем рабочие значения: сокет, умерший молча,
  // иначе замечается только по TCP. Ноль — это осознанный выбор «выключить»,
  // и он сохраняется как есть, а не подменяется умолчанием.
  const hasPing = config.pingInterval !== undefined
  print('Периодический опрос — страховка, если сокет не поднялся. Ноль выключает.')
  print('Пинг по сокету — проверка «сервер слышит меня»: 15 с и растяжение до 10 раз,')
  print('  когда сервер давно ничего не присылал. Ноль выключает пинг совсем.')
  return {
    pollIdleMs: Number(await askDefault(ask, 'Периодический опрос, мс (0 — только события)', config.pollIdleMs ?? 0)) || 0,
    pingInterval: Number(await askDefault(ask, 'Пинг по сокету, с (0 — выключен)', config.pingInterval ?? (hasPing ? 0 : 15))) || 0,
    maxPingIntervalFactor: Number(await askDefault(ask, 'Во сколько раз растягивать пинг без работы (0 — не растягивать)', config.maxPingIntervalFactor ?? (hasPing ? 0 : 10))) || 0,
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
    print('Мастер настройки: спрашивает по одному разделу и объясняет, что к чему.')
    print('Текущее значение стоит в скобках; пустой ответ его не меняет.')
    print('')
    print('1) доступ: имя, каталоги, режимы, кто отвечает на вопросы')
    print('2) связь: опрос, пинг по сокету')
    print('3) автозапуск: systemd-юнит')
    print('4) показать конфиг')
    print('0) выход')
    const choice = (await ask('Что настроить? ') ?? '').trim()
    if (choice === '0' || choice === '') return

    if (choice === '1') {
      const { url, policy } = pickPolicy(config)
      if (!url) {
        print('Сначала подключись к серверу: dshnc connect <ссылка>. Без сервера')
        print('правила доступа писать некуда — они живут в разделе этого сервера.')
        continue
      }
      print(`Правила для ${url}`)
      const patch = await askAccess({ ask, print, config, policy, url })
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
      const patch = await askConnection({ ask, print, config })
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
