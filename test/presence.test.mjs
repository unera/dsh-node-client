import assert from 'node:assert/strict'
import { test } from 'node:test'

test('номер соединения растёт и переживает перезапуск', async () => {
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
    // новый процесс читает то же состояние: счётчик не сбрасывается
    const second = openStore({ dir })
    assert.equal(second.nextConn(url), 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})



test('описания передачи файлов называют направление, а не наоборот', async () => {
  const { t } = await import('../lib/i18n.mjs')
  // copyToDevice — на устройство (хост → узел), copyFromDevice — с устройства
  assert.match(t('files.copyToDevice.description'), /(host to this node|с хоста на этот узел|从主机复制文件到本节点)/)
  assert.match(t('files.copyFromDevice.description'), /(this node to the host|с этого узла на хост|从本节点复制文件到主机)/)
})
