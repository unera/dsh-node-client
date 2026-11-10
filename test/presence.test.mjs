import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

import { openStore } from '../lib/store.mjs'

test('the connection counter grows and survives a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-conn-'))
  try {
    const store = openStore({ dir })
    const url = 'http://127.0.0.1:9/x'
    assert.equal(store.nextClientEpoch(url), 1)
    assert.equal(store.nextClientEpoch(url), 2)
    // the new process reads the same state: the counter is not reset
    const second = openStore({ dir })
    assert.equal(second.nextClientEpoch(url), 3)
    store.close()
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a state file with the old conn key keeps counting instead of starting from one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-conn-legacy-'))
  try {
    const url = 'http://127.0.0.1:9/x'
    const empty = openStore({ dir })
    empty.close()
    // before the rename the counter lived under `conn:`: a server that already knows a
    // bigger number would take the first connection after the upgrade for a stale one
    const db = new DatabaseSync(join(dir, 'state.sqlite'))
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`conn:${url}`, '5')
    db.close()
    const store = openStore({ dir })
    assert.equal(store.nextClientEpoch(url), 6, 'old data is continued, not restarted')
    store.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file transfer descriptions name the direction, not the other way round', async () => {
  const { t } = await import('../lib/i18n.mjs')
  // copyToDevice - onto the device (host -> node), copyFromDevice - from the device
  assert.match(t('files.copyToDevice.description'), /(host to this node|с хоста на этот узел|从主机复制文件到本节点)/)
  assert.match(t('files.copyFromDevice.description'), /(this node to the host|с этого узла на хост|从本节点复制文件到主机)/)
})
