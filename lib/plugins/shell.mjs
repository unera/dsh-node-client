/**
 * Плагин `shell`: выполнить команду на узле и вернуть результат.
 *
 * Раньше API назывался `bash`, что было правдой только на POSIX: на Windows та
 * же команда уходит в PowerShell. Имя `shell` честнее, а старое имя осталось
 * отдельным плагином-алиасом, чтобы не ломать уже настроенные серверы.
 *
 * @module dsh-node-client/plugins/shell
 */
import { runBash } from '../bash.mjs'
import { pipeFrom, pipeTo } from './pipe-run.mjs'
import { t } from '../i18n.mjs'
import { CLIENT_VERSION } from '../api.mjs'

/** Общее описание метода: один и тот же exec для shell и для старого bash. */
export function execMethod () {
  return {
    method: 'exec',
    description: t('bash.exec.description'),
    args: {
      type: 'object',
      properties: {
        command: { type: 'string', description: t('bash.arg.command') },
        cwd: { type: 'string', description: t('bash.arg.cwd') },
        timeout: { type: 'number', description: t('bash.arg.timeout') },
        stdin: { type: 'string', description: t('bash.arg.stdin') },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }
}

/** Объявления пайпов: результат едет обычным результатом команды. */
export function pipeMethods () {
  return [
    {
      method: 'pipeFromDevice',
      description: 'Выполнить команду и отдать её вывод в файл на сервере (поток, без временного файла)',
      args: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'что выполнять (sh -c)' },
          hostPath: { type: 'string', description: 'куда на сервере положить вывод' },
          cwd: { type: 'string', description: 'рабочий каталог на узле' },
          timeout: { type: 'number', description: 'секунды' },
        },
        required: ['command', 'hostPath'],
        additionalProperties: false,
      },
    },
    {
      method: 'pipeToDevice',
      description: 'Подать файл с сервера на stdin команды',
      args: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'что выполнять (sh -c)' },
          hostPath: { type: 'string', description: 'откуда на сервере брать данные' },
          cwd: { type: 'string', description: 'рабочий каталог на узле' },
          timeout: { type: 'number', description: 'секунды' },
        },
        required: ['command', 'hostPath'],
        additionalProperties: false,
      },
    },
  ]
}

export function api () {
  return {
    name: 'shell',
    version: CLIENT_VERSION,
    description: t('bash.api.description'),
    methods: [execMethod(), ...pipeMethods()],
  }
}

/**
 * Исполнить команду.
 * @param {{method: string, args: object, timeout?: number}} command
 * @param {{shell?: string, signal?: AbortSignal}} ctx
 */
export async function handle (command, ctx = {}) {
  if (command.method === 'pipeFromDevice') return await pipeFrom(command, ctx)
  if (command.method === 'pipeToDevice') return await pipeTo(command, ctx)
  if (command.method !== 'exec') {
    return { ok: false, code: 'unknown_method', message: `shell: unknown method ${command.method}` }
  }
  const args = command.args ?? {}
  // Приоритет: явный cwd в аргументах → каталог сессии → ничего (наследуем).
  let cwd = args.cwd
  if (!cwd && ctx.sessions && ctx.session) {
    try {
      cwd = ctx.sessions.cwd(ctx.session, { workdir: ctx.workdir, roots: ctx.roots })
    } catch (error) {
      // каталог сессии не сделали — лучше сказать прямо, чем исполнить команду
      // в чужом каталоге и сделать вид, что так и надо
      return { ok: false, code: error.code ?? 'bad_session', message: error.message }
    }
  }
  return runBash({
    command: args.command,
    cwd,
    timeout: command.timeout ?? args.timeout,
    stdin: args.stdin,
    sandbox: ctx.sandbox ?? null,
    shell: ctx.shell,
    signal: ctx.signal,
  })
}
