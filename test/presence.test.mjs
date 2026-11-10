import assert from 'node:assert/strict'
import { test } from 'node:test'

test('the connection number grows and survives a restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openStore } = await import('../lib/store.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-conn-'))
  try {
    const store = openStore({ dir })
    const url = 'http://127.0.0.1:9/x'
    assert.equal(store.nextConn(url), 1)
    assert.equal(store.nextConn(url), 2)
    // the new process reads the same state: the counter is not reset
    const second = openStore({ dir })
    assert.equal(second.nextConn(url), 3)
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
