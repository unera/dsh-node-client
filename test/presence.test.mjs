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

test('hello несёт номер соединения', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/presence.mjs', import.meta.url), 'utf8')
  assert.match(source, /conn: conn \?\? null/, 'в кадре hello должно быть поле conn')
})

test('разрыв сокета не превращается в опрос: клиент переподключается', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/runner.mjs', import.meta.url), 'utf8')
  // при закрытии канала presence обнуляется и цикл будится заново
  assert.match(source, /presence = null[\s\S]{0,200}setTimeout\(nudge, 1000\)/,
    'после разрыва цикл должен проснуться и открыть присутствие заново')
  assert.ok(!/falling back to polling/.test(source))
})

test('описания передачи файлов совпадают с поведением', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/i18n.mjs', import.meta.url), 'utf8')
  // copyToDevice — на устройство (хост → узел), copyFromDevice — с устройства
  assert.match(source, /'files\.copyToDevice\.description': '[^']*(?:host to this node|с хоста на этот узел|从主机复制文件到本节点)/)
  assert.match(source, /'files\.copyFromDevice\.description': '[^']*(?:this node to the host|с этого узла на хост|从本节点复制文件到主机)/)
})
