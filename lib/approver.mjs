/**
 * Локальный апрув: спросить человека за этой машиной.
 *
 * Работает через внешнюю команду из настроек узла — `zenity`, `notify-send`,
 * `powershell`, что угодно. Отдельный модуль, потому что тут легко ошибиться:
 * текст вопроса приходит извне (его собрал сервер из команды модели), и
 * подставлять его прямо в командную строку нельзя — это была бы инъекция.
 *
 * Поэтому: `%s` в шаблоне заменяется на экранированный текст, а полный JSON
 * уходит на stdin. Команда запускается без оболочки, списком аргументов.
 *
 * @module dsh-node-client/approver
 */
import { spawn } from 'node:child_process'

/**
 * Аргументы команды апрува.
 *
 * Два способа передать текст:
 *  - в шаблоне есть `%s` → подставляем в аргумент (для `zenity --question --text=%s`);
 *  - нет `%s` → текст уходит на stdin (для `zenity --text-info`), и тогда длина
 *    вопроса ничем не ограничена командной строкой.
 *
 * Разбиение делается до подстановки: иначе пробелы из вопроса разорвали бы
 * аргумент на части. Оболочки здесь нет, поэтому экранировать нечего.
 */
export function buildArgs (template, prompt) {
  const args = splitArgs(template)
  if (!template.includes('%s')) return args
  return args.map((arg) => arg.replaceAll('%s', String(prompt)))
}

/** Пойдёт ли текст в аргументы или на stdin. */
export function usesStdin (template) {
  return !String(template).includes('%s')
}

/** Разбить строку на аргументы, уважая кавычки. */
export function splitArgs (template) {
  const args = []
  let current = ''
  let quote = null
  for (const char of template) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) args.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

/**
 * Спросить человека.
 *
 * `ok` команды = «разрешаю»: инструмент задаёт вопрос так, что код 0 означает
 * согласие (`zenity --question` возвращает 0 на «Yes»), ненулевой — отказ или
 * закрытое окно. Это же поведение у `notify-send` с действиями не получится,
 * поэтому для таких случаев нужен свой скрипт — конфиг это позволяет.
 *
 * @param {object} options
 * @param {string} options.tool команда из настроек
 * @param {string} options.prompt текст вопроса
 * @param {string} options.payload JSON для stdin
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeout] секунды
 * @returns {Promise<boolean>} true — разрешено
 */
export function askLocally ({ tool, prompt, payload, signal, timeout = 86400 }) {
  return new Promise((resolve, reject) => {
    const argv = buildArgs(tool, prompt)
    if (!argv.length) {
      reject(Object.assign(new Error('пустая команда апрува'), { code: 'no_local_approver' }))
      return
    }
    // структурированные данные — в окружение, человеку — текст на stdin
    const env = {
      ...process.env,
      DSHNC_APPROVAL_ID: String(payload?.id ?? ''),
      DSHNC_APPROVAL_MODE: String(payload?.mode ?? ''),
    }
    const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'], env })
    let stderr = ''
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {}
      finish(reject, Object.assign(new Error('апрув отменён'), { code: 'cancelled' }))
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {}
      finish(reject, Object.assign(new Error('апрув истёк'), { code: 'approve_timeout' }))
    }, Math.max(1, timeout) * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2000) stderr += chunk
    })
    child.on('error', (error) => finish(reject, Object.assign(error, { code: 'approve_failed' })))
    child.on('close', (code) => {
      if (code === 0) finish(resolve, true)
      else finish(resolve, false)
      void stderr
    })
    // инструмент может не читать stdin и выйти сразу — это не ошибка
    child.stdin.on('error', () => {})
    try {
      // диалогу нужен человеческий текст; JSON отдаём переменными окружения
      child.stdin.end(usesStdin(tool) ? String(prompt) : String(payload))
    } catch {}
  })
}
