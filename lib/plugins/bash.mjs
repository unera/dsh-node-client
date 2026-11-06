/**
 * Первый плагин клиента: shell на машине узла.
 *
 * Плагин — это обычный модуль с двумя вещами: `api` (что объявляем серверу) и
 * `handle(command, ctx)` (как исполняем). Больше от него ничего не требуется,
 * поэтому новый плагин пишется как один файл в ~/.dshnc/plugins/<имя>/index.mjs.
 *
 * @module dsh-node-client/plugins/bash
 */
import { runBash } from '../bash.mjs'

export const api = {
  name: 'bash',
  version: '1',
  description: 'Shell на машине узла',
  methods: [
    {
      method: 'exec',
      description: 'Выполнить команду в shell; вернуть stdout, stderr и код возврата',
      args: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Командная строка' },
          cwd: { type: 'string', description: 'Рабочий каталог' },
          timeout: { type: 'number', description: 'Таймаут в секундах' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  ],
}

/**
 * Исполнить команду плагина.
 * @param {{method: string, args: object, timeout?: number}} command
 * @param {{shell?: string, signal?: AbortSignal}} ctx
 */
export async function handle (command, ctx = {}) {
  if (command.method !== 'exec') {
    return { ok: false, code: 'unknown_method', message: `bash не знает метода ${command.method}` }
  }
  const args = command.args ?? {}
  return runBash({
    command: args.command,
    cwd: args.cwd,
    timeout: command.timeout ?? args.timeout,
    shell: ctx.shell,
    signal: ctx.signal,
  })
}
