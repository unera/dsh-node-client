/**
 * Session directories on the client.
 *
 * Every session has its own directory inside workdir: `<workdir>/<session-id>`. It
 * is also the working directory of the commands of that session. The directory can
 * be switched through the built-in `session` plugin (the `chdir` method), but only
 * within `roots` from the config — otherwise the sandbox would stop meaning
 * anything.
 *
 * The choice lives in `state.sqlite`, so it survives a daemon restart.
 *
 * @module dsh-node-client/sessions
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Invalid session identifier: `.` and `..` do not mean a name but a traversal. */
export function safeSessionName (session) {
  const safe = String(session ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  if (!safe || safe === '.' || safe === '..') {
    throw Object.assign(new Error(`недопустимый идентификатор сессии: ${JSON.stringify(session)}`), { code: 'bad_session' })
  }
  return safe
}

/**
 * Canonical path: `realpath` for an existing one, and for a non-existent tail —
 * the canonicalized nearest existing parent plus the remainder.
 */
export function canonicalPath (input) {
  const absolute = isAbsolute(input) ? input : resolve(input)
  if (existsSync(absolute)) return realpathSync(absolute)
  const parts = []
  let current = absolute
  while (!existsSync(current)) {
    parts.unshift(current.slice(current.lastIndexOf(sep) + 1))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return join(existsSync(current) ? realpathSync(current) : current, ...parts)
}

/** Whether the path lies inside the root (by directory boundary, not by string prefix). */
export function inside (path, root) {
  const canonicalRoot = canonicalPath(root)
  if (path === canonicalRoot) return true
  return path.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep)
}

/** Which directories may host sessions. `['/']` — the whole host. */
export function normalizeRoots (roots) {
  const list = Array.isArray(roots) && roots.length ? roots : ['/']
  return list.map((root) => canonicalPath(String(root)))
}

/**
 * Check and prepare the session directory.
 *
 * @param {object} options
 * @param {string} options.workdir base directory (from the node settings)
 * @param {string} options.session session identifier
 * @param {string[]} [options.roots] where directories may be created
 * @returns {{dir: string, created: boolean}}
 */
export function prepareSessionDir ({ workdir, session, roots }) {
  if (typeof workdir !== 'string' || !workdir.trim()) {
    throw Object.assign(new Error('рабочая директория не задана'), { code: 'workdir_invalid' })
  }
  const allowed = normalizeRoots(roots)
  const dir = join(canonicalPath(workdir), safeSessionName(session))
  assertInside(dir, allowed)
  const created = !existsSync(dir)
  if (created) mkdirSync(dir, { recursive: true })
  if (!statSync(dir).isDirectory()) {
    throw Object.assign(new Error(`${dir} не каталог`), { code: 'workdir_invalid' })
  }
  return { dir, created }
}

/** Check that the path is inside one of the allowed roots. */
export function assertInside (path, roots) {
  const allowed = normalizeRoots(roots)
  const target = canonicalPath(path)
  if (!allowed.some((root) => inside(target, root))) {
    throw Object.assign(new Error(`каталог ${target} вне разрешённых: ${allowed.join(', ')}`), { code: 'workdir_denied' })
  }
  return target
}

/** Store of the chosen session directories. */
export function createSessionStore (store) {
  return {
    /**
     * Session directory: the one chosen earlier, otherwise `<workdir>/<session>`.
     * @returns {string}
     */
    dir (session, { workdir, roots } = {}) {
      // the previously chosen directory was already checked against `roots` when it was switched
      const saved = store.readSessionDir?.(session)
      if (saved && existsSync(saved)) return saved
      return prepareSessionDir({ workdir, session, roots }).dir
    },

    /**
     * Switch the session directory. The directory must exist: creating one is a
     * separate action (`mkdir`), so that `chdir` does no implicit things.
     */
    chdir (session, path, { roots } = {}) {
      const target = assertInside(path, roots)
      if (!existsSync(target)) {
        throw Object.assign(new Error(`каталога ${target} нет`), { code: 'workdir_not_found' })
      }
      if (!statSync(target).isDirectory()) {
        throw Object.assign(new Error(`${target} не каталог`), { code: 'workdir_invalid' })
      }
      store.writeSessionDir?.(session, target)
      return { dir: target }
    },

    /**
     * Create a directory inside the allowed roots.
     * @param {string} session session
     * @param {string} path path
     * @param {object} options
     * @param {string[]} options.roots allowed roots
     * @param {number} [options.mode] permissions (0o755 by default)
     */
    mkdir (session, path, { roots, mode = 0o755 } = {}) {
      const target = assertInside(path, roots)
      if (existsSync(target)) {
        if (!statSync(target).isDirectory()) {
          throw Object.assign(new Error(`${target} уже существует и это не каталог`), { code: 'workdir_invalid' })
        }
        return { dir: target, created: false }
      }
      mkdirSync(target, { recursive: true, mode })
      try {
        chmodSync(target, mode)
      } catch {}
      return { dir: target, created: true }
    },

    /** Current session directory, without creating it. */
    cwd (session, { workdir, roots } = {}) {
      return this.dir(session, { workdir, roots })
    },
  }
}
