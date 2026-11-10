/**
 * The built-in `session` plugin: switching the working directory of a session.
 *
 * This is not an external tool but a session reconfigure: the model says "from now
 * on we work in the foobar directory", and every following command of that session
 * starts there. It is needed purely for convenience — so that the model does not
 * repeat `cd` in every command.
 *
 * The directory is checked against the `roots` list from the node settings:
 * switching outside them is forbidden, otherwise the sandbox would lose its point.
 *
 * @module dsh-node-client/plugins/session
 */
import { CLIENT_VERSION } from '../api.mjs'
import { t } from '../i18n.mjs'

export function api () {
  return {
    name: 'session',
    // the contract changed (chdir became strict, mkdir was added) — the version has
    // to grow, otherwise nodes with different schemas would merge into one record
    // the contract grew again: the ping method was added
    version: CLIENT_VERSION,
    description: t('session.api.description'),
    // rules are announced as a separate list (announce.applyRules): changing the
    // directory changes the condition for all other commands — it can be neither
    // overtaken nor overtake (spec/SPECIAL-RULES.md on the server side)
    rules: [
      { method: 'chdir', rule: 'flushAround' },
      // the server does the measuring of the ping: the duration by its own marks,
      // the clock skew by the node's time from the envelope. Both fields are put
      // into the answer under the names below
      {
        method: 'ping',
        rule: 'timing',
        rulesOpts: { retNames: { durationMs: 'durationMs', clockSkewMs: 'clockSkewMs' } },
      },
    ],
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
        method: 'id',
        description: t('session.id.description'),
        args: { type: 'object', properties: {}, required: [], additionalProperties: false },
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
 * Execute a command of the plugin.
 * @param {{method: string, args: object}} command
 * @param {{session: string, sessions?: object, roots?: string[], workdir?: string}} ctx
 */
export async function handle (command, ctx = {}) {
  // The connectivity check depends neither on the session nor on directories: we
  // answer before any other checks, otherwise `ping` on a node without sessions
  // would sound like a breakage.
  if (command.method === 'id') {
    // the number of the session the command arrived in: through it the human can
    // send an event from the device into the same chat
    return {
      ok: true,
      results: [{ type: 'text', text: JSON.stringify({ session: command.session ?? null, node: ctx.node ?? null }) }],
    }
  }
  if (command.method === 'version') {
    // version and platform: clients of different platforms are numbered their own
    // way, hence the single line `desktop-x.y.z` / `android-x.y.z`
    return text({ version: CLIENT_VERSION, platform: process.platform, node: process.version })
  }
  if (command.method === 'ping') {
    // We measure nothing ourselves: measuring is the job of the `timing` rule on the
    // server, the node only hands out facts about itself. It puts its own clock into
    // the envelope of every result anyway, and that is enough for the skew.
    return {
      ok: true,
      results: [{
        type: 'text',
        text: JSON.stringify({
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
