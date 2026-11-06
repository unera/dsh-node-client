/**
 * Каталоги сессий на клиенте.
 *
 * У каждой сессии свой каталог внутри workdir: `<workdir>/<session-id>`. Он же
 * рабочий каталог команд этой сессии. Каталог можно переключить через встроенный
 * плагин `session` (метод `chdir`), но только внутри `roots` из конфига — иначе
 * песочница перестала бы что-либо значить.
 *
 * Выбор живёт в `state.sqlite`, поэтому переживает рестарт демона.
 *
 * @module dsh-node-client/sessions
 */
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

/** Недопустимый идентификатор сессии: `.` и `..` означают не имя, а переход. */
export function safeSessionName (session) {
  const safe = String(session ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120)
  if (!safe || safe === '.' || safe === '..') {
    throw Object.assign(new Error(`недопустимый идентификатор сессии: ${JSON.stringify(session)}`), { code: 'bad_session' })
  }
  return safe
}

/**
 * Канонический путь: для существующего — `realpath`, для несуществующего хвоста —
 * канонизация ближайшего существующего родителя плюс остаток.
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

/** Лежит ли путь внутри корня (по границе каталога, а не по префиксу строки). */
export function inside (path, root) {
  const canonicalRoot = canonicalPath(root)
  if (path === canonicalRoot) return true
  return path.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep)
}

/** Какие каталоги разрешены к размещению сессий. `['/']` — весь хост. */
export function normalizeRoots (roots) {
  const list = Array.isArray(roots) && roots.length ? roots : ['/']
  return list.map((root) => canonicalPath(String(root)))
}

/**
 * Проверить и подготовить каталог сессии.
 *
 * @param {object} options
 * @param {string} options.workdir базовый каталог (из настроек узла)
 * @param {string} options.session идентификатор сессии
 * @param {string[]} [options.roots] где разрешено создавать каталоги
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

/** Проверить, что путь внутри одного из разрешённых корней. */
export function assertInside (path, roots) {
  const allowed = normalizeRoots(roots)
  const target = canonicalPath(path)
  if (!allowed.some((root) => inside(target, root))) {
    throw Object.assign(new Error(`каталог ${target} вне разрешённых: ${allowed.join(', ')}`), { code: 'workdir_denied' })
  }
  return target
}

/** Хранилище выбранных каталогов сессий. */
export function createSessionStore (store) {
  return {
    /**
     * Каталог сессии: выбранный ранее, иначе `<workdir>/<session>`.
     * @returns {string}
     */
    dir (session, { workdir, roots } = {}) {
      // выбранный ранее каталог уже проверен по `roots` в момент переключения
      const saved = store.readSessionDir?.(session)
      if (saved && existsSync(saved)) return saved
      return prepareSessionDir({ workdir, session, roots }).dir
    },

    /** Переключить каталог сессии: путь проверяется по `roots` и создаётся. */
    chdir (session, path, { roots } = {}) {
      const target = assertInside(path, roots)
      const created = !existsSync(target)
      if (created) mkdirSync(target, { recursive: true })
      if (!statSync(target).isDirectory()) {
        throw Object.assign(new Error(`${target} не каталог`), { code: 'workdir_invalid' })
      }
      store.writeSessionDir?.(session, target)
      return { dir: target, created }
    },

    /** Текущий каталог сессии, без создания. */
    cwd (session, { workdir, roots } = {}) {
      return this.dir(session, { workdir, roots })
    },
  }
}
