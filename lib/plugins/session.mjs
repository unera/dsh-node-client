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
    version: '1',
    description: t('session.api.description'),
    methods: [
      {
        method: 'chdir',
        description: t('session.chdir.description'),
        args: {
          type: 'object',
          properties: {
            path: { type: 'string', description: t('session.chdir.arg.path') },
            create: { type: 'boolean', description: t('session.chdir.arg.create') },
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

  if (command.method !== 'chdir') {
    return { ok: false, code: 'unknown_method', message: `session: unknown method ${command.method}`, results: null }
  }

  try {
    const result = sessions.chdir(session, command.args.path, { roots: ctx.roots })
    return {
      ok: true,
      code: 'chdir',
      message: result.dir,
      results: [{ type: 'text', text: `${result.dir}${result.created ? t('session.created') : ''}` }],
    }
  } catch (error) {
    return { ok: false, code: error.code ?? 'workdir_denied', message: error.message, results: null }
  }
}
