/**
 * The `shell` plugin: run a command on the node and return the result.
 *
 * The API used to be called `bash`, which was true only on POSIX: on Windows the
 * same command goes to PowerShell. The name `shell` is more honest, and the old
 * name survives as a separate alias plugin so as not to break servers that are
 * already configured.
 *
 * @module dsh-node-client/plugins/shell
 */
import { runBash } from '../bash.mjs'
import { cancelRunning, pipeFrom, pipeTo } from './pipe-run.mjs'
import { forgetRunning, registerRunning } from '../running.mjs'
import { handleApproveCommand } from '../approve-command.mjs'
import { t } from '../i18n.mjs'
import { CLIENT_VERSION } from '../api.mjs'

/** Common method description: the same exec for shell and for the old bash. */
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

/** Pipe declarations: the result travels as an ordinary command result. */
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
 * Execute a command.
 * @param {{method: string, args: object, timeout?: number}} command
 * @param {{shell?: string, signal?: AbortSignal}} ctx
 */
/**
 * Control commands (`#…`). They are not declared in the API: the server knows what
 * they are by itself. Cancellation is cleanup, therefore "nothing to stop" is a
 * success rather than an error.
 * `#INTERNAL.FLUSH` is a barrier: we wait for the pool to empty and only then
 * answer.
 */
export async function handleControl (command, ctx = {}) {
  if (command.method === '#INTERNAL.CANCEL') return cancelRunning(command.args?.seq)
  if (command.method === '#INTERNAL.APPROVE') return await handleApproveCommand(command, ctx)
  if (command.method === '#INTERNAL.FLUSH') {
    // already empty is a success too: "there was nothing to wait for" is not an error
    await ctx.drain?.()
    return { ok: true, results: [{ type: 'text', text: JSON.stringify({ flushed: true }) }] }
  }
  return { ok: true, results: [{ type: 'text', text: JSON.stringify({ ignored: command.method }) }] }
}

export async function handle (command, ctx = {}) {
  if (command.method === 'pipeFromDevice') return await pipeFrom(command, ctx)
  if (command.method === 'pipeToDevice') return await pipeTo(command, ctx)
  if (command.method !== 'exec') {
    return { ok: false, code: 'unknown_method', message: `shell: unknown method ${command.method}` }
  }
  const args = command.args ?? {}
  // Priority: an explicit cwd in the arguments → the session directory → nothing
  // (we inherit).
  let cwd = args.cwd
  if (!cwd && ctx.sessions && ctx.session) {
    try {
      cwd = ctx.sessions.cwd(ctx.session, { workdir: ctx.workdir, roots: ctx.roots })
    } catch (error) {
      // the session directory was not created — better to say so directly than to
      // run the command in a foreign directory and pretend that this is intended
      return { ok: false, code: error.code ?? 'bad_session', message: error.message }
    }
  }
  try {
    return await runBash({
      command: args.command,
      cwd,
      timeout: command.timeout ?? args.timeout,
      stdin: args.stdin,
      sandbox: ctx.sandbox ?? null,
      shell: ctx.shell,
      signal: ctx.signal,
      // while the command runs, `#INTERNAL.CANCEL` must find it: without a record in
      // the registry, the cancel arrived into emptiness and the process ran to the end
      onSpawn: (stopper) => registerRunning(command.seq, stopper),
    })
  } finally {
    forgetRunning(command.seq)
  }
}
