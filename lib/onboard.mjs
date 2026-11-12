/**
 * The setup wizard: one node, one server, flat settings.
 *
 * A menu rather than a stream of questions, because different things have to be
 * configured and in a different order: someone came for the access rules, someone
 * for the autostart.
 *
 * The main rule: **the current value is the proposed default**, and an empty answer
 * keeps it. That way the wizard does not break an already configured node and does
 * not require remembering what was there.
 *
 * The config is flat — there is no per-server section to pick, because a client
 * serves exactly one server. A second node is a second config (`dshnc -c <file>`).
 *
 * @module dsh-node-client/onboard
 */

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
export async function askAccess ({ ask, print = () => {}, config = {} }) {
  const patch = {}
  // The wizard does not just ask — it explains what each answer means. Without that
  // the human answers "blindly" and then does not understand why the node refuses to
  // write or does not ask questions.
  print('Имя узла — это то, чем узел зовут в вызовах и что видно в админке.')
  patch.name = await askDefault(ask, 'Имя узла', config.name ?? '')
  patch.aliases = toList(await askDefault(ask, 'Алиасы через запятую', toList(config.aliases).join(', ')))
  print('Каталог сессий — где клиент заводит рабочие каталоги для моделей.')
  patch.workdir = await askDefault(ask, 'Каталог сессий (абсолютный путь)', config.workdir ?? '')
  print('Разрешённые каталоги — границы записи: всё вне них узлу недоступно на запись.')
  patch.roots = toList(await askDefault(ask, 'Разрешённые каталоги через запятую', toList(config.roots).join(', ')))
  const modes = ['ro', 'rw', 'full']
  print('Потолок прав — самый широкий режим, который узел разрешит вообще:')
  print('  ro — только чтение, rw — запись внутри разрешённых каталогов, full — без песочницы.')
  patch.max = await askDefault(ask, `Потолок прав (${modes.join('/')})`, config.max ?? 'rw')
  print('Стартовый режим — в каком режиме команда запускается по умолчанию.')
  print('  Он может быть уже потолка: тогда расширение требует разрешения человека.')
  patch.base = await askDefault(ask, `Стартовый режим (${modes.join('/')})`, config.base ?? 'rw')
  print('Кто отвечает на вопрос «разрешить шире?»:')
  print('  local — человек за этой машиной (окно на узле), server — человек в DSH, none — не спрашивать.')
  const approver = await askDefault(ask, 'Кто отвечает на вопросы: local/server/none', config.approver ?? 'none')
  patch.approver = approver
  if (approver === 'local') {
    const current = config?.ask?.local?.tool?.command ?? ''
    print('Команда вопроса — чем на этой машине спросить человека. Подойдёт любой')
    print('  инструмент, который возвращает 0 на «да»:')
    print('    zenity --text-info --width=600 --title=dsh-nodes')
    print('    kdialog --textinputbox "dsh-nodes"')
    print('    notify-send ... && свой скрипт, который ждёт ответа')
    print('  Текст вопроса уходит в stdin, если в команде нет %s.')
    const tool = await askDefault(ask, 'Команда вопроса (пусто — не спрашивать)', current)
    patch.ask = tool
      ? { local: { enabled: true, tool: { type: 'external', command: tool } } }
      : { local: { enabled: false } }
  }
  return patch
}

/** The "connection" menu item: polling and the socket ping. */
export async function askConnection ({ ask, print = () => {}, config = {} }) {
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
  delete plain.policy
  delete plain.id
  return JSON.stringify(plain, null, 2)
}

/**
 * The "connection" menu item: a link from the admin page, or a token entered by hand.
 *
 * The wizard itself does not talk to the network: it only collects the answer and
 * hands it to `connect`, which is the CLI's business. Both ways end in the same
 * place — the address becomes the `server` key of the config, the token goes to the
 * shared `credentials.yaml`.
 *
 * @param {object} options
 * @returns {Promise<{link?: string, server?: string, token?: string}|null>} what to connect
 */
export async function askConnectionTarget ({ ask, print = () => {}, config = {} }) {
  print(`Сервер сейчас: ${config.server ?? 'не подключён'}`)
  print('Ссылка из админки: с кодом — подключится сразу, без кода — заявка на одобрение.')
  print('  Токен, выданный вручную, вставляется ниже: тогда нужен и адрес сервера.')
  const link = (await ask('Ссылка (пусто — ввести токен вручную): ') ?? '').trim()
  if (link) return { link }
  const server = (await askDefault(ask, 'Адрес сервера', config.server ?? '')).trim()
  if (!server) {
    print('Без ссылки и без адреса подключать нечего.')
    return null
  }
  const token = (await ask('Токен (пусто — не менять): ') ?? '').trim()
  return { server, token }
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
 * @param {(target: object) => Promise<string|null>} [options.connect] connect and return the address
 */
export async function runOnboard ({ ask, print, load, save, autostart, status = () => [], connect = null }) {
  for (;;) {
    const config = load()
    print('')
    for (const line of status(config)) print(line)
    print('')
    print('Мастер настройки: спрашивает по одному разделу и объясняет, что к чему.')
    print('Текущее значение стоит в скобках; пустой ответ его не меняет.')
    print('')
    print('1) подключение: ссылка из админки или токен')
    print('2) доступ: имя, каталоги, режимы, кто отвечает на вопросы')
    print('3) связь: опрос, пинг по сокету')
    print('4) автозапуск: systemd-юнит')
    print('5) показать конфиг')
    print('0) выход')
    const choice = (await ask('Что настроить, 1-5 или 0 — выход [0]: ') ?? '').trim()
    if (choice === '0' || choice === '') return

    if (choice === '1') {
      if (!connect) {
        print('Подключение настраивается командой `dshnc connect <ссылка>`.')
        continue
      }
      const target = await askConnectionTarget({ ask, print, config })
      if (!target) continue
      const address = await connect(target)
      print(address ? `подключено: ${address}` : 'не подключено')
      continue
    }

    if (choice === '2') {
      if (!config.server) {
        print('Сначала подключись к серверу: dshnc connect <ссылка>. Без сервера')
        print('узел не знает, кому служить, и правила доступа писать некуда.')
        continue
      }
      print(`Правила для ${config.server}`)
      const patch = await askAccess({ ask, print, config })
      // we show the result BEFORE writing: a preview must not save anything
      print('')
      print('Итог:')
      print(renderConfig({ ...config, ...patch }))
      const ok = (await ask('Записать [Y]: ') ?? '').trim().toLowerCase()
      if (ok === '' || ok === 'y' || ok === 'да') {
        save(patch)
        print('сохранено')
      } else {
        print('не записано')
      }
      continue
    }

    if (choice === '3') {
      const patch = await askConnection({ ask, print, config })
      save(patch)
      print('сохранено')
      continue
    }

    if (choice === '4') {
      await autostart(load())
      continue
    }

    if (choice === '5') {
      print(renderConfig(load()))
      continue
    }

    print('нет такого пункта')
  }
}
