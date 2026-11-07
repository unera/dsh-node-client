/**
 * Мастер настройки: меню, значения по умолчанию, запись только по согласию.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { askAccess, askConnection, renderConfig, runOnboard } from '../lib/onboard.mjs'

/** Ответы по очереди, как будто их вводят руками. */
function asker (answers) {
  const queue = [...answers]
  const asked = []
  const ask = async (question) => {
    asked.push(question)
    return queue.shift() ?? ''
  }
  return { ask, asked }
}

test('пустой ответ оставляет текущее значение и оно видно в подсказке', async () => {
  const { ask, asked } = asker(['', '', '', '', '', ''])
  const config = { name: 'nbw', aliases: ['ноут'], workdir: '/w', roots: ['/w'] }
  const patch = await askAccess({ ask, config, policy: { max: 'full', base: 'rw', approver: 'none' }, url: 'https://x' })
  assert.equal(patch.name, 'nbw')
  assert.deepEqual(patch.aliases, ['ноут'])
  assert.equal(patch.policy['https://x'].max, 'full')
  assert.equal(patch.policy['https://x'].approver, 'none')
  assert.match(asked[0], /\[nbw\]/, 'текущее значение должно быть в подсказке')
})

test('ответы меняют значения, approver=local спрашивает команду вопроса', async () => {
  const { ask, asked } = asker(['ноут2', 'a, b', '/work', '/work, /tmp', 'full', 'rw', 'local', 'zenity --text-info'])
  const patch = await askAccess({ ask, config: {}, policy: {}, url: 'https://x' })
  assert.equal(patch.name, 'ноут2')
  assert.deepEqual(patch.aliases, ['a', 'b'])
  assert.deepEqual(patch.policy['https://x'].roots, ['/work', '/tmp'])
  assert.equal(patch.policy['https://x'].max, 'full')
  assert.equal(patch.policy['https://x'].approver, 'local')
  assert.equal(patch.policy['https://x'].ask.local.tool.command, 'zenity --text-info')
  assert.ok(asked.some((question) => /Команда вопроса/.test(question)))
})

test('связь: пустой ответ сохраняет прежнее, ноль остаётся нулём', async () => {
  const { ask } = asker(['', '', ''])
  const patch = await askConnection({ ask, print: () => {}, config: { pollIdleMs: 0, pingInterval: 0, maxPingIntervalFactor: 0 } })
  assert.equal(patch.pollIdleMs, 0, 'ноль — это выбор, а не «не задано»')
  assert.equal(patch.pingInterval, 0)
  assert.equal(patch.maxPingIntervalFactor, 0)
})

test('связь: в новом конфиге предлагаются 15 с и растяжение 10', async () => {
  const asked = []
  const ask = async (question) => { asked.push(question); return '' }
  const patch = await askConnection({ ask, print: () => {}, config: {} })
  assert.equal(patch.pingInterval, 15)
  assert.equal(patch.maxPingIntervalFactor, 10)
  assert.equal(patch.pollIdleMs, 0)
})

test('меню: правка не записывается без согласия', async () => {
  const saved = []
  let config = { name: 'nbw', policy: { 'https://x': {} } }
  // 1 → четыре ответа на вопросы доступа → «n» на подтверждение → 0 выход
  // 1 → имя + шесть пустых ответов (прочие поля) → «n» на подтверждение → 0
  const { ask } = asker(['1', 'новое', '', '', '', '', '', 'n', '0'])
  await runOnboard({
    ask,
    print: () => {},
    load: () => config,
    save: (patch) => { saved.push(patch); config = { ...config, ...patch }; return config },
    autostart: async () => {},
  })
  assert.deepEqual(saved, [], 'без «y» ничего не сохраняем')
})

test('меню: согласие сохраняет один раз', async () => {
  const saved = []
  let config = { name: 'nbw', policy: { 'https://x': {} } }
  const { ask } = asker(['1', 'новое', '', '', '', '', '', '', 'y', '0'])
  await runOnboard({
    ask,
    print: () => {},
    load: () => config,
    save: (patch) => { saved.push(patch); config = { ...config, ...patch }; return config },
    autostart: async () => {},
  })
  assert.equal(saved.length, 1)
  assert.equal(config.name, 'новое')
})

test('renderConfig не показывает служебные поля', () => {
  const text = renderConfig({ name: 'nbw', servers: { a: 1 }, id: 'x' })
  assert.doesNotMatch(text, /servers/)
  assert.doesNotMatch(text, /"id"/)
  assert.match(text, /nbw/)
})
