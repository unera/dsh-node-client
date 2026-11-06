/**
 * Первый плагин клиента: shell на машине узла.
 *
 * Плагин — модуль с двумя вещами: `api` (что объявляем серверу) и
 * `handle(command, ctx)` (как исполняем). `api` может быть объектом или
 * функцией: функция нужна, чтобы описания попадали в объявление на языке
 * клиента, а не были зашиты при импорте модуля.
 *
 * @module dsh-node-client/plugins/bash
 */
import { runBash } from '../bash.mjs'
import { t } from '../i18n.mjs'

export function api () {
  return {
    name: 'bash',
    version: '2',
    description: t('bash.api.description'),
    methods: [
      {
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
      },
    ],
  }
}

/**
 * Исполнить команду плагина.
 * @param {{method: string, args: object, timeout?: number}} command
 * @param {{shell?: string, signal?: AbortSignal}} ctx
 */
export async function handle (command, ctx = {}) {
  if (command.method !== 'exec') {
    return { ok: false, code: 'unknown_method', message: `bash: unknown method ${command.method}` }
  }
  const args = command.args ?? {}
  return runBash({
    command: args.command,
    cwd: args.cwd,
    timeout: command.timeout ?? args.timeout,
    stdin: args.stdin,
    shell: ctx.shell,
    signal: ctx.signal,
  })
}
