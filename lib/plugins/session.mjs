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
import { t } from '../i18n.mjs'

export function api () {
  return {
    name: 'session',
    // контракт изменился (chdir стал строгим, добавился mkdir) — версия обязана
    // вырасти, иначе узлы с разными схемами слипнутся в одну запись
    version: '2',
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
