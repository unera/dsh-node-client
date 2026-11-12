/**
 * Setup wizard: menu, default values, writing only with consent.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { askAccess, askConnection, renderConfig, runOnboard } from '../lib/onboard.mjs'

/** Answers one by one, as if they were typed by hand. */
function asker (answers) {
  const queue = [...answers]
  const asked = []
  const ask = async (question) => {
    asked.push(question)
    return queue.shift() ?? ''
  }
  return { ask, asked }
}

test('an empty answer keeps the current value and it is visible in the prompt', async () => {
  const { ask, asked } = asker(['', '', '', '', '', ''])
  const config = { name: 'nbw', aliases: ['ноут'], workdir: '/w', roots: ['/w'] }
  const patch = await askAccess({ ask, config, policy: { max: 'full', base: 'rw', approver: 'none' }, url: 'https://x' })
  assert.equal(patch.name, 'nbw')
  assert.deepEqual(patch.aliases, ['ноут'])
  assert.equal(patch.policy['https://x'].max, 'full')
  assert.equal(patch.policy['https://x'].approver, 'none')
  assert.match(asked[0], /\[nbw\]/, 'текущее значение должно быть в подсказке')
})

test('answers change the values, approver=local asks for the question command', async () => {
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

test('connection: an empty answer keeps the previous one, zero stays zero', async () => {
  const { ask } = asker(['', ''])
  const patch = await askConnection({ ask, print: () => {}, config: { pingInterval: 0, maxPingIntervalFactor: 0 } })
  // we no longer ask about polling: it does not exist at all, only the socket wakes it up
  assert.equal('pollIdleMs' in patch, false)
  assert.equal(patch.pingInterval, 0)
  assert.equal(patch.maxPingIntervalFactor, 0)
})

test('connection: the new config offers 15 s and a stretch of 10', async () => {
  const asked = []
  const ask = async (question) => { asked.push(question); return '' }
  const patch = await askConnection({ ask, print: () => {}, config: {} })
  assert.equal(patch.pingInterval, 15)
  assert.equal(patch.maxPingIntervalFactor, 10)
  assert.equal('pollIdleMs' in patch, false, 'опроса нет, и настройки для него нет')
})

test('menu: an edit is not written without consent', async () => {
  const saved = []
  let config = { name: 'nbw', policy: { 'https://x': {} } }
  // 1 -> four answers to the access questions -> "n" to the confirmation -> 0 to exit
  // 1 -> name + six empty answers (the other fields) -> "n" to the confirmation -> 0
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

test('menu: consent saves once', async () => {
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

test('renderConfig does not show internal fields', () => {
  const text = renderConfig({ name: 'nbw', servers: { a: 1 }, id: 'x' })
  assert.doesNotMatch(text, /servers/)
  assert.doesNotMatch(text, /"id"/)
  assert.match(text, /nbw/)
})

test('a connected node without rules can be configured: the server comes from the token', async () => {
  // the bug this test remembers: a node paired a minute ago has a token but no rules,
  // and the wizard told its owner "connect to a server first" and refused to work
  let config = { name: 'mx', pingInterval: 15 }
  const saved = []
  const { ask } = asker([
    '1', 'mx', '', '/home/unera/work', '/home/unera/work', 'rw', 'rw', 'none', 'y', '0',
  ])
  await runOnboard({
    ask,
    print: () => {},
    load: () => config,
    save: (patch) => { saved.push(patch); config = { ...config, ...patch }; return config },
    autostart: async () => {},
    servers: () => ['https://srv/dsh-nodes'],
  })
  assert.equal(saved.length, 1, 'правка записана')
  assert.equal(saved[0].policy['https://srv/dsh-nodes'].roots[0], '/home/unera/work')
})
