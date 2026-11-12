/**
 * Question label: the default value must not be duplicated.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatQuestion } from '../lib/ask.mjs'

test('the default is added when it is not in the text', () => {
  assert.equal(formatQuestion('Имя узла', 'nbw'), 'Имя узла [nbw]: ')
  assert.equal(formatQuestion('Имя узла'), 'Имя узла: ')
})

test('the default is not duplicated when it is already in brackets', () => {
  const question = 'Запускать системной службой [system] или в твоей сессии [user]'
  assert.equal(formatQuestion(question, 'user'), question + ': ')
  assert.equal(formatQuestion('Внутри графической сессии? [y/N]', 'n'), 'Внутри графической сессии? [y/N]: ')
})

test('trailing spaces do not break the rule', () => {
  assert.equal(formatQuestion('Вопрос [y/N]   ', 'n'), 'Вопрос [y/N]: ')
})

test('a prompt offers its default once, in one pair of brackets', async () => {
  // the wizard and the autostart ask the same style of question: a colon at the end and
  // exactly one default in brackets. Two values inside brackets ("[y/n]", "[system] …
  // [user]") read as two different defaults and the human cannot tell which one wins
  const { table } = await import('../lib/i18n.mjs')
  const suspicious = []
  for (const language of ['en', 'ru', 'zh']) {
    for (const [key, value] of Object.entries(table(language))) {
      if (!key.startsWith('auto.')) continue
      if (/\[[^\]]*[/|][^\]]*\]/.test(value)) suspicious.push(`${language}:${key}: ${value}`)
      if ((value.match(/\[[^\]]*\]/g) ?? []).length > 1) suspicious.push(`${language}:${key}: ${value}`)
    }
  }
  assert.deepEqual(suspicious, [])
})

test('a rendered question ends with a colon', async () => {
  const { formatQuestion } = await import('../lib/ask.mjs')
  assert.equal(formatQuestion('Имя узла', 'nbw'), 'Имя узла [nbw]: ')
  assert.equal(formatQuestion('Записать', 'Y'), 'Записать [Y]: ')
})
