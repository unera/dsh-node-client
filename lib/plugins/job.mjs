/**
 * The `job` plugin: long-running processes on the node.
 *
 * A separate API rather than an `exec` mode: background work has a different
 * contract — an answer at once, reading the output by offset, an explicit kill of the
 * group.
 *
 * @module dsh-node-client/plugins/job
 */
import { createJobRegistry } from '../jobs.mjs'
import { t } from '../i18n.mjs'
import { CLIENT_VERSION } from '../api.mjs'

/** One registry per client: `dshnc daemon` lives long, processes are many. */
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
      // directory: explicit → session directory, as in `shell.exec`
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
        // the same sandbox as exec: the node policy extends to background processes too
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

/** Kill everything when the daemon stops: processes must not outlive the client. */
export function stopAll () {
  registry?.stopAll()
}
