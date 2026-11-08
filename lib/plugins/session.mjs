/**
 * Встроенный плагин `session`: переключение рабочего каталога сессии.
 *
 * Это не внешний инструмент, а реконфиг сессии: модель говорит «дальше работаем
 * в каталоге foobar», и все последующие команды этой сессии стартуют там. Нужно
 * ровно для удобства — чтобы модель не повторяла `cd` в каждой команде.
 *
 * Каталог проверяется по списку `roots` из настроек узла: вне их переключение
 * запрещено, иначе песочница потеряла бы смысл.
 *
 * @module dsh-node-client/plugins/session
 */
import { CLIENT_VERSION } from '../api.mjs'
import { preciseNow } from '../shell.mjs'
import { t } from '../i18n.mjs'

export function api () {
  return {
    name: 'session',
    // контракт изменился (chdir стал строгим, добавился mkdir) — версия обязана
    // вырасти, иначе узлы с разными схемами слипнутся в одну запись
    // контракт снова вырос: добавлен метод ping
    version: '4',
    description: t('session.api.description'),
    methods: [
      {
        method: 'chdir',
        description: t('session.chdir.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string', description: t('session.chdir.arg.path') },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'mkdir',
        description: t('session.mkdir.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string', description: t('session.mkdir.arg.path') },
            mode: { type: 'string', description: t('session.mkdir.arg.mode') },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
      {
        method: 'version',
        description: t('session.version.description'),
        args: { type: 'object', properties: {}, required: [], additionalProperties: false },
      },
      {
        method: 'ping',
        description: t('session.ping.description'),
        args: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        method: 'approve',
        description: t('session.approve.description'),
        args: {
          type: 'object',
          properties: {
            id: { type: 'string', description: t('session.approve.arg.id') },
            text: { type: 'string', description: t('session.approve.arg.text') },
            mode: { type: 'string', description: t('session.approve.arg.mode') },
          },
          required: ['id', 'text'],
          additionalProperties: false,
        },
      },
      {
        method: 'cwd',
        description: t('session.cwd.description'),
        args: {
          type: 'object',
          properties: {
            session: { type: 'string', description: t('session.arg.session') },
          },
          additionalProperties: false,
        },
      },
    ],
  }
}

/**
 * Выполнить команду плагина.
 * @param {{method: string, args: object}} command
 * @param {{session: string, sessions?: object, roots?: string[], workdir?: string}} ctx
 */
export async function handle (command, ctx = {}) {
  // Проверка связи не зависит ни от сессии, ни от каталогов: отвечаем раньше
  // любых проверок, иначе `ping` на узле без сессий звучал бы как поломка.
  if (command.method === 'version') {
    // версия и платформа: клиенты разных платформ нумеруются по-своему,
    // поэтому одной строкой `desktop-x.y.z` / `android-x.y.z`
    return text({ version: CLIENT_VERSION, platform: process.platform, node: process.version })
  }
  if (command.method === 'ping') {
    // Возвращаем отметку сервера обратно и добавляем свою: по этой паре
    // сервер считает и время отклика, и разницу часов между машинами.
    return {
      ok: true,
      results: [{
        type: 'text',
        text: JSON.stringify({
          pong: preciseNow(),
          // Поле объявлено, но не заполняется: узел не знает, сколько занял
          // раундтрип по часам сервера. Сервер подставит значение сам.
          rttMs: null,
          sentAt: command.issuedAt ?? null,
          upSeconds: Math.round(process.uptime()),
          platform: process.platform,
          version: CLIENT_VERSION,
        }),
      }],
    }
  }

  const session = command.args?.session ?? ctx.session
  const sessions = ctx.sessions
  if (!sessions) {
    return { ok: false, code: 'session_unavailable', message: t('session.noStore'), results: null }
  }
  if (!session) {
    return { ok: false, code: 'bad_session', message: t('session.noSession'), results: null }
  }

  if (command.method === 'cwd') {
    try {
      const dir = sessions.cwd(session, { workdir: ctx.workdir, roots: ctx.roots })
      return { ok: true, code: 'cwd', message: dir, results: [{ type: 'text', text: dir }] }
    } catch (error) {
      return { ok: false, code: error.code ?? 'workdir_invalid', message: error.message, results: null }
    }
  }

  // Апрув — внутренняя команда: она не ходит через `bash`, поэтому песочница её
  // не касается и отказать ей некому. Спрашиваем человека инструментом из
  // настроек узла; нет инструмента — честная ошибка, а не тишина.
  if (command.method === 'approve') {
    const tool = ctx.approver?.command
    if (!tool) {
      return { ok: false, code: 'no_local_approver', message: t('session.approve.noTool'), results: null }
    }
    const prompt = String(command.args.text ?? '')
    // Идентификаторы для инструмента вопроса: по ним диалог может запомнить
    // «отвечать да до конца вопроса» и «до конца сессии».
    const payload = JSON.stringify({
      id: command.args.id,
      mode: command.args.mode ?? null,
      text: prompt,
      session: command.session ?? null,
      question: command.question ?? null,
    })
    const started = Date.now()
    try {
      const verdict = await ctx.approver.run({ tool, prompt, payload, signal: ctx.signal, timeout: command.timeout })
      return {
        ok: true,
        code: verdict ? 'approved' : 'cancelled',
        message: verdict ? 'ok' : 'cancel',
        results: [{ type: 'text', text: JSON.stringify({ approved: Boolean(verdict), seconds: Math.round((Date.now() - started) / 1000) }) }],
      }
    } catch (error) {
      return { ok: false, code: error.code ?? 'approve_failed', message: error.message, results: null }
    }
  }

  if (command.method === 'mkdir') {
    try {
      const mode = typeof command.args.mode === 'string' ? Number.parseInt(command.args.mode, 8) : undefined
      const result = sessions.mkdir(session, command.args.path, {
        roots: ctx.roots,
        mode: Number.isFinite(mode) ? mode : undefined,
      })
      return {
        ok: true,
        code: 'mkdir',
        message: result.dir,
        results: [{ type: 'text', text: `${result.dir}${result.created ? t('session.created') : t('session.exists')}` }],
      }
    } catch (error) {
      return { ok: false, code: error.code ?? 'workdir_denied', message: error.message, results: null }
    }
  }

  if (command.method !== 'chdir') {
    return { ok: false, code: 'unknown_method', message: `session: unknown method ${command.method}`, results: null }
  }

  try {
    const result = sessions.chdir(session, command.args.path, { roots: ctx.roots })
    return { ok: true, code: 'chdir', message: result.dir, results: [{ type: 'text', text: result.dir }] }
  } catch (error) {
    return { ok: false, code: error.code ?? 'workdir_denied', message: error.message, results: null }
  }
}
