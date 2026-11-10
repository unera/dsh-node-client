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
