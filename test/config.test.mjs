/**
 * Конфиг клиента: правки из CLI не должны теряться, пока демон работает.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'


test('сохранение не затирает правку, сделанную другим процессом', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-cfg-'))
  process.env.DSHNC_HOME = dir
  const { loadConfig, saveConfig } = await import('../lib/config.mjs')
  const daemon = loadConfig()
  // CLI поменял рабочую директорию и записал это
  const cli = loadConfig()
  cli.workdir = '/tmp/from-cli'
  saveConfig(cli)
  // демон продолжает жить со своим объектом и сохраняет курсор
  daemon.servers['http://x/dsh-nodes'] = { token: 't', cursor: 5 }
  saveConfig(daemon)
  const after = loadConfig()
  assert.equal(after.workdir, '/tmp/from-cli', 'правка CLI должна выжить')
  assert.equal(after.servers['http://x/dsh-nodes'].cursor, 5)
  delete process.env.DSHNC_HOME
  rmSync(dir, { recursive: true, force: true })
})
