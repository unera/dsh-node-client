/**
 * Client plugins: the built-in bash, a user plugin from ~/.dshnc,
 isolation of a broken plugin and pairing connection by link.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apisOf, loadPlugins, resolvePlugin } from '../lib/plugins/index.mjs'

let dir
before(() => { dir = mkdtempSync(join(tmpdir(), 'dshnc-plugins-')) })
after(() => rmSync(dir, { recursive: true, force: true }))

test('the built-in bash always loads first', async () => {
  const plugins = await loadPlugins({ dir })
  assert.equal(plugins[0].api.name, 'shell', 'первым идёт shell: bash остался алиасом')
  assert.equal(plugins[0].api.methods[0].method, 'exec')
  assert.equal(plugins[0].builtin, true)
})

test('a user plugin is picked up from the directory', async () => {
  const home = join(dir, 'plug')
  mkdirSync(join(home, 'echo'), { recursive: true })
  writeFileSync(join(home, 'echo', 'index.mjs'), `
export const api = {
  name: 'echo',
  version: '1',
  methods: [{ method: 'say', args: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }],
}
export async function handle (command) {
  return { ok: true, results: [{ type: 'text', text: String(command.args?.text ?? '') }] }
}
`)
  const plugins = await loadPlugins({ dir: home })
  assert.deepEqual(plugins.map((plugin) => plugin.api.name), ['shell', 'job', 'files', 'session', 'echo'])
  assert.deepEqual(apisOf(plugins).map((entry) => entry.name), ['shell', 'job', 'files', 'session', 'echo'])

  const plugin = resolvePlugin(plugins, { api: 99, method: 'say' }, {})
  assert.equal(plugin.api.name, 'echo')
  const outcome = await plugin.handle({ method: 'say', args: { text: 'привет' } })
  assert.equal(outcome.results[0].text, 'привет')
})

test('a broken plugin does not take the others down', async () => {
  const home = join(dir, 'broken')
  mkdirSync(join(home, 'bad'), { recursive: true })
  writeFileSync(join(home, 'bad', 'index.mjs'), 'export const api = { name: "bad" }')
  const warnings = []
  const plugins = await loadPlugins({ dir: home, log: (level, message) => warnings.push(message) })
  assert.deepEqual(plugins.map((plugin) => plugin.api.name), ['shell', 'job', 'files', 'session'])
  assert.match(warnings.join(' '), /bad/)
})

test('resolvePlugin first by API number, then by method', async () => {
  const plugins = await loadPlugins({ dir })
  const byId = resolvePlugin(plugins, { api: 7, method: 'exec' }, { shell: 7 })
  assert.equal(byId.api.name, 'shell', 'по номеру API — тот, кто его держит')
  // the number is unknown, the `exec` method exists in two plugins: we take the first one, shell
  const byMethod = resolvePlugin(plugins, { api: 404, method: 'exec' }, { shell: 7 })
  assert.equal(byMethod.api.name, 'shell')
  assert.equal(resolvePlugin(plugins, { api: 404, method: 'nope' }, {}), null)
})
