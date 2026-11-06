/**
 * Песочница клиента: три режима поверх `bwrap`.
 *
 * Идея не наша — она взята у DSH (`@deepseek-ai/dsh-sandbox-local`, MIT): там
 * ровно тот же профиль `bwrap` и те же таблицы сигнатур отказа. Повторяем
 * профиль сами, потому что их пакет тянет cordis, платформенные ветки и 6 МБ
 * политик, а нам нужны 40 строк и предсказуемое поведение.
 *
 * Главное, что нужно понимать про детект отказа: **ничего не предсказывается**.
 * Команда запускается под изоляцией, ядро само не пускает запись, а мы уже после
 * факта смотрим код возврата и stderr и решаем, был ли это отказ песочницы.
 *
 * `LC_ALL=C` обязателен: сообщения ядра локализованы («Файловая система доступна
 * только для чтения»), и английская сигнатура на русской локали не совпадёт.
 * DSH делает то же самое в `dsh-subprocess-local`.
 *
 * @module dsh-node-client/sandbox
 */
import { spawnSync } from 'node:child_process'

/** Режимы по возрастанию прав: слева уже, справа шире. */
export const MODES = ['ro', 'rw', 'full']

/** Сигнатуры отказа, которые печатает ядро под `bwrap` (как в DSH). */
export const DENIAL_SIGNATURES = ['read-only file system']

/** Признаки поломки самого раннера: это не отказ политики, а «не запустилось». */
export const RUNNER_SIGNATURES = ['bwrap: ']

/**
 * Отображение наших режимов на режимы DSH — чтобы тексты и лестница эскалации
 * совпадали с тем, что модель видит в основном DSH.
 */
export const DSH_MODES = { ro: 'read-only', rw: 'workspace-write', full: 'danger-full-access' }

/** Лестница «строго шире»: во что можно повышать режим. */
export const WIDER_MODES = {
  ro: ['rw', 'full'],
  rw: ['full'],
  full: [],
}

/** Сравнить режимы: вернуть тот, что уже (ближе к ro). */
export function narrower (a, b) {
  return MODES.indexOf(a) <= MODES.indexOf(b) ? a : b
}

/**
 * Профиль `bwrap` для режима.
 *
 * - `ro`   — весь хост только на чтение, сеть отрезана;
 * - `rw`   — плюс запись в каталог workdir и в /tmp, сеть отрезана;
 * - `full` — профиля нет, команда запускается как есть.
 *
 * @param {object} options
 * @param {'ro'|'rw'|'full'} options.mode
 * @param {string} [options.workdir] каталог, разрешённый на запись в режиме rw
 * @param {string} [options.cwd] рабочий каталог команды
 * @param {string[]} [options.mask] каталоги, которые надо спрятать (--tmpfs)
 * @returns {string[]} аргументы bwrap до `--`
 */
export function profileArgs ({ mode, workdir, writable = [], cwd, mask = [] }) {
  if (mode === 'full') return []
  const args = [
    '--ro-bind', '/', '/',
    '--dev', '/dev',
    '--unshare-pid',
    '--unshare-net',
    '--proc', '/proc',
    '--die-with-parent',
  ]
  for (const path of mask) args.push('--tmpfs', path)
  if (mode === 'rw') {
    args.push('--tmpfs', '/tmp')
    // запись разрешена в каждый разрешённый владельцем корень: сессия может
    // переехать в соседний каталог (`session.chdir`), и он должен остаться
    // доступным на запись, иначе rw превращается в ro после первого переезда
    const targets = [...new Set([...(writable ?? []), workdir].filter(Boolean))]
    for (const path of targets) args.push('--bind', path, path)
  }
  if (cwd) args.push('--chdir', cwd)
  return args
}

let probeCache = null

/**
 * Работает ли `bwrap` на этой машине. Проверяется один раз за процесс: профиль
 * `ro` против самого себя, команда `true`. Не работает — значит изоляции нет,
 * и режимы `ro`/`rw` обязаны отказать, а не сделать вид, что всё хорошо.
 *
 * @returns {{available: boolean, version?: string, reason?: string}}
 */
export function probe (run = spawnSync) {
  if (probeCache) return probeCache
  const args = [...profileArgs({ mode: 'ro' }), '--', 'true']
  try {
    const result = run('bwrap', args, { timeout: 5000, stdio: 'ignore' })
    if (result.status === 0) {
      const version = run('bwrap', ['--version'], { timeout: 2000, encoding: 'utf8' })
      probeCache = { available: true, version: String(version.stdout ?? '').trim() }
    } else {
      probeCache = { available: false, reason: `bwrap вернул ${result.status}` }
    }
  } catch (error) {
    probeCache = { available: false, reason: error?.message ?? 'bwrap недоступен' }
  }
  return probeCache
}

/** Сбросить кэш пробы (тесты). */
export function resetProbe () {
  probeCache = null
}

/**
 * Разобрать результат запуска: это отказ песочницы, поломка раннера или
 * обычная ошибка команды.
 *
 * @param {object} options
 * @param {number|null} options.code код возврата
 * @param {string} [options.stderr] stderr процесса
 * @param {'ro'|'rw'|'full'} options.mode
 * @param {string} [options.enforcement]
 * @returns {{denied: boolean, runnerFailure: boolean, signature: string|null}}
 */
export function classify ({ code, stderr = '', mode, enforcement = 'bwrap' }) {
  const text = String(stderr ?? '').toLowerCase()
  const signature = DENIAL_SIGNATURES.find((needle) => text.includes(needle)) ?? null
  const runnerFailure = RUNNER_SIGNATURES.some((needle) => text.includes(needle))
  // отказ — только при ненулевом коде возврата: команда, которая просто
  // напечатала «read-only file system», отказом не считается
  // Код возврата не обязателен: `echo … ; echo …` в одной строке возвращает 0,
  // хотя запись уже была отвергнута. Сигнатура в stderr — единственный
  // надёжный признак, а ложное срабатывание стоит одного лишнего вопроса.
  const denied = mode !== 'full' && !runnerFailure && signature !== null
  return { denied, runnerFailure, signature: denied ? signature : null }
}

/** Ошибка «изоляции нет»: команда не должна запускаться вообще. */
export class SandboxUnavailableError extends Error {
  constructor (message, reason) {
    super(message)
    this.name = 'SandboxUnavailableError'
    this.code = 'sandbox_unavailable'
    this.reason = reason
  }
}
