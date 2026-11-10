/**
 * The initial setup wizard: `dshnc onboard`.
 *
 * A menu rather than a stream of questions, because different things have to be
 * configured and in a different order: someone came for the access policy, someone
 * for the autostart.
 *
 * The main rule: **the current value is the proposed default**, and an empty answer
 * keeps it. That way the wizard does not break an already configured node and does
 * not require remembering what was there.
 *
 * @module dsh-node-client/onboard
 */

/**
 * Take the rules of the server the node is connected to.
 *
 * The policy is stored per server address, so "the current cap" is not
 * `config.policy` but `config.policy[url]`. If there are several servers, we take the
 * first one: the wizard edits one node at a time, and it cannot move rules between
 * servers, nor should it pretend that it can.
 *
 * @param {object} config client settings
 * @returns {{url: string|null, policy: object}}
 */
export function pickPolicy (config) {
  const entries = Object.entries(config?.policy ?? {})
  if (!entries.length) return { url: null, policy: {} }
  const [url, policy] = entries[0]
  return { url, policy: policy ?? {} }
}

/** Answer with a hint: empty input keeps the previous value. */
async function askDefault (ask, question, current) {
  const shown = current === null || current === undefined || current === ''
    ? question
    : `${question} [${current}]`
  const answer = (await ask(`${shown}: `) ?? '').trim()
  return answer === '' ? current : answer
}

/** Comma-separated list ↔ array. */
function toList (value) {
  if (Array.isArray(value)) return value
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

/**
 * The "access" menu item: name, directories, modes, who answers the questions.
 *
 * @returns {Promise<object>} changes that have to be saved
 */
export async function askAccess ({ ask, print = () => {}, config, policy, url = null }) {
  const patch = {}
  // The wizard does not just ask — it explains what each answer means. Without that
  // the human answers "blindly" and then does not understand why the node refuses to
  // write or does not ask questions.
  print('Имя узла — это то, чем узел зовут в вызовах и что видно в админке.')
  patch.name = await askDefault(ask, 'Имя узла', config.name ?? '')
  patch.aliases = toList(await askDefault(ask, 'Алиасы через запятую', toList(config.aliases).join(', ')))
  print('Каталог сессий — где клиент заводит рабочие каталоги для моделей.')
  // the client reads the directories from the server policy when they are set there,
  // so the default we offer is exactly those, not the empty root of the config
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

  // both the directories and the modes go into the section of this server: the
  // runner builds the common values from the root and overlays the server policy on
  // top, so a root without a policy would look like "configured but not working"
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
  // we write the rules into the server being configured: otherwise they end up nowhere
  patch.policy = url
    ? { ...(config.policy ?? {}), [url]: { ...(config.policy?.[url] ?? {}), ...next } }
    : (config.policy ?? {})
  return patch
}

/** The "connection" menu item: polling and the socket ping. */
export async function askConnection ({ ask, print = () => {}, config }) {
  // For a new configuration we offer working values: a socket that died silently is
  // otherwise noticed only by TCP. Zero is a deliberate choice of "disable", and it
  // is saved as is, not replaced with the default.
  const hasPing = config.pingInterval !== undefined
  print('Пинг по сокету — проверка «сервер слышит меня»: 15 с и растяжение до 10 раз,')
  print('  когда сервер давно ничего не присылал. Ноль выключает пинг совсем.')
  return {
    pingInterval: Number(await askDefault(ask, 'Пинг по сокету, с (0 — выключен)', config.pingInterval ?? (hasPing ? 0 : 15))) || 0,
    maxPingIntervalFactor: Number(await askDefault(ask, 'Во сколько раз растягивать пинг без работы (0 — не растягивать)', config.maxPingIntervalFactor ?? (hasPing ? 0 : 10))) || 0,
  }
}

/** Show what came out: before writing, the human must see the result. */
export function renderConfig (config) {
  const plain = { ...config }
  delete plain.servers
  delete plain.id
  return JSON.stringify(plain, null, 2)
}

/**
 * The menu loop.
 *
 * @param {object} options
 * @param {(question: string) => Promise<string>} options.ask
 * @param {(text: string) => void} options.print
 * @param {() => object} options.load fresh settings
 * @param {(patch: object) => object} options.save save and return the result
 * @param {(config: object) => Promise<void>} options.autostart run the autostart wizard
 * @param {() => string[]} [options.status] status lines for the header
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
      // we show the result BEFORE writing: a preview must not save anything
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
