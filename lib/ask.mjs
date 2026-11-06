/**
 * Подпись вопроса для интерактивного ввода.
 *
 * Значение по умолчанию показывается в квадратных скобках — но только если оно
 * уже не показано в самом тексте вопроса. Иначе получается «...[user] [user]»,
 * что и случилось на первом запуске мастера.
 *
 * @param {string} question текст вопроса
 * @param {string} [fallback] значение по умолчанию
 * @returns {string} строка с двоеточием на конце
 */
export function formatQuestion (question, fallback) {
  const text = String(question ?? '').trim()
  const hasBracketDefault = /\[[^\]]*\]\s*$/.test(text)
  const suffix = fallback && !hasBracketDefault ? ` [${fallback}]` : ''
  return `${text}${suffix}: `
}
