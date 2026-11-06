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
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
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

    /**
     * Переключить каталог сессии. Каталог должен существовать: создание — это
     * отдельное действие (`mkdir`), чтобы `chdir` не делал неявных вещей.
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
     * Создать каталог внутри разрешённых корней.
     * @param {string} session сессия
     * @param {string} path путь
     * @param {object} options
     * @param {string[]} options.roots разрешённые корни
     * @param {number} [options.mode] права (по умолчанию 0o755)
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

    /** Текущий каталог сессии, без создания. */
    cwd (session, { workdir, roots } = {}) {
      return this.dir(session, { workdir, roots })
    },
  }
}
