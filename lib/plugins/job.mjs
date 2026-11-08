/**
 * Плагин `job`: долгоиграющие процессы на узле.
 *
 * Отдельный API, а не режим `exec`: у фоновой работы другой контракт — ответ
 * сразу, чтение вывода по смещению, явное убийство группы.
 *
 * @module dsh-node-client/plugins/job
 */
import { createJobRegistry } from '../jobs.mjs'
import { t } from '../i18n.mjs'
import { CLIENT_VERSION } from '../api.mjs'

/** Реестр один на клиента: `dshnc daemon` живёт долго, процессов много. */
let registry = null
function jobs () {
  registry ??= createJobRegistry()
  return registry
}

export function api () {
  return {
    name: 'job',
    version: CLIENT_VERSION,
    description: t('job.api.description'),
    methods: [
      {
        method: 'start',
        description: t('job.start.description'),
        args: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' },
            timeout: { type: 'number', description: t('job.arg.timeout') },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
      {
        method: 'output',
        description: t('job.output.description'),
        args: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            offset: { type: 'number', description: t('job.arg.offset') },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        method: 'kill',
        description: t('job.kill.description'),
        args: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            signal: { type: 'string', enum: ['SIGTERM', 'SIGKILL'] },
          },
          required: ['id'],
          additionalProperties: false,
        },
      },
      {
        method: 'list',
        description: t('job.list.description'),
        args: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  }
}

export async function handle (command, ctx = {}) {
  const args = command.args ?? {}
  const registry = jobs()
  switch (command.method) {
    case 'start': {
      // каталог: явный → каталог сессии, как у `shell.exec`
      let cwd = args.cwd
      if (!cwd && ctx.sessions && ctx.session) {
        try {
          cwd = ctx.sessions.cwd(ctx.session, { workdir: ctx.workdir, roots: ctx.roots })
        } catch (error) {
          return { ok: false, code: error.code ?? 'bad_session', message: error.message }
        }
      }
      return registry.start({
        command: args.command,
        cwd,
        shell: ctx.shell,
        timeout: args.timeout ?? command.timeout,
        // та же песочница, что у exec: политика узла распространяется и на фоновые процессы
        sandbox: ctx.sandbox ?? null,
      })
    }
    case 'output':
      return registry.output(args.id, args.offset)
    case 'kill':
      return registry.kill(args.id, args.signal ?? 'SIGTERM')
    case 'list':
      return registry.list()
    default:
      return { ok: false, code: 'unknown_method', message: `job: unknown method ${command.method}` }
  }
}

/** Убить всё при остановке демона: процессы не должны пережить клиента. */
export function stopAll () {
  registry?.stopAll()
}
