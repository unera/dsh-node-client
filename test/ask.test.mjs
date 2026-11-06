/**
 * Подпись вопроса: значение по умолчанию не должно дублироваться.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatQuestion } from '../lib/ask.mjs'

test('умолчание добавляется, когда его нет в тексте', () => {
  assert.equal(formatQuestion('Имя узла', 'nbw'), 'Имя узла [nbw]: ')
  assert.equal(formatQuestion('Имя узла'), 'Имя узла: ')
})

test('умолчание не дублируется, если оно уже в скобках', () => {
  const question = 'Запускать системной службой [system] или в твоей сессии [user]'
  assert.equal(formatQuestion(question, 'user'), question + ': ')
  assert.equal(formatQuestion('Внутри графической сессии? [y/N]', 'n'), 'Внутри графической сессии? [y/N]: ')
})

test('хвостовые пробелы не ломают правило', () => {
  assert.equal(formatQuestion('Вопрос [y/N]   ', 'n'), 'Вопрос [y/N]: ')
})
