/**
 * Question prompt for interactive input.
 *
 * The default value is shown in square brackets — but only if it is not already
 * shown in the question text itself. Otherwise you get "...[user] [user]",
 * which is what happened on the first run of the wizard.
 *
 * @param {string} question question text
 * @param {string} [fallback] default value
 * @returns {string} string with a colon at the end
 */
export function formatQuestion (question, fallback) {
  const text = String(question ?? '').trim()
  const hasBracketDefault = /\[[^\]]*\]\s*$/.test(text)
  const suffix = fallback && !hasBracketDefault ? ` [${fallback}]` : ''
  return `${text}${suffix}: `
}
