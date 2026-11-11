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

/**
 * A socket that says nothing on its own: it can be opened, but it never reports a close.
 *
 * That is not a hypothetical: a route that vanished under an established TCP connection
 * leaves exactly this — the library's `close()` sends a close frame and waits forever, no
 * event arrives, and the daemon waits with it.
 */
class SilentSocket {
  constructor () {
    this.readyState = 1
    this.listeners = new Map()
    this.sent = []
    this.closeCalled = false
  }

  addEventListener (type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  emit (type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  send (data) { this.sent.push(data) }

  close () { this.closeCalled = true }
}

/** Install the fake socket for the duration of one test. */
function withSocket (socket, body) {
  const original = globalThis.WebSocket
  globalThis.WebSocket = function () { return socket }
  return body().finally(() => { globalThis.WebSocket = original })
}

test('a channel that answers no ping is torn down by the client itself', async () => {
  const socket = new SilentSocket()
  await withSocket(socket, async () => {
    const events = []
    const lines = []
    const { openPresence } = await import('../lib/presence.mjs')
    openPresence({
      base: 'http://127.0.0.1:9/x',
      token: 'token',
      pingInterval: 0.05,
      onEvent: (event) => events.push(event),
      log: (level, message) => lines.push(message),
    })
    socket.emit('open', {})
    // one interval for the ping, one for the answer that never comes
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(events.filter((event) => event.type === 'closed').map((e) => e.code), [4002],
      'the daemon gets a closed event even though the socket never sent one')
    assert.equal(socket.closeCalled, true, 'the abandoned socket is still asked to close')
    assert.ok(lines.some((line) => line.includes('рву канал') || line.includes('tearing')),
      'the forced teardown is visible in the log')
  })
})

test('a channel that never opens does not hang the daemon either', async () => {
  const socket = new SilentSocket()
  await withSocket(socket, async () => {
    const events = []
    const { openPresence } = await import('../lib/presence.mjs')
    openPresence({
      base: 'http://127.0.0.1:9/x',
      token: 'token',
      pingInterval: 5,
      openTimeoutMs: 60,
      onEvent: (event) => events.push(event),
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(events.map((event) => event.code), [4003],
      'an unopened channel ends with its own code instead of silence')
  })
})

test('the channel is finished once, whoever notices first', async () => {
  const socket = new SilentSocket()
  await withSocket(socket, async () => {
    const events = []
    const { openPresence } = await import('../lib/presence.mjs')
    openPresence({
      base: 'http://127.0.0.1:9/x',
      token: 'token',
      pingInterval: 0.05,
      onEvent: (event) => events.push(event),
    })
    socket.emit('open', {})
    // the ping goes out, no answer comes, the watchdog finishes the channel
    await new Promise((resolve) => setTimeout(resolve, 200))
    // and only now the library gets round to reporting the close it had all along
    socket.emit('close', { code: 1000, reason: 'bye' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const closed = events.filter((event) => event.type === 'closed')
    assert.deepEqual(closed.map((event) => event.code), [4002],
      'the second report must not overwrite the first one or start a second reconnect')
  })
})

test('a channel that opens quickly is not killed later by its own open watchdog', async () => {
  const socket = new SilentSocket()
  await withSocket(socket, async () => {
    const events = []
    const { openPresence } = await import('../lib/presence.mjs')
    openPresence({
      base: 'http://127.0.0.1:9/x',
      token: 'token',
      // the ping is off: only the open watchdog could fire here
      pingInterval: 0,
      openTimeoutMs: 60,
      onEvent: (event) => events.push(event),
    })
    socket.emit('open', {})
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.deepEqual(events.map((event) => event.code ?? event.type), [],
      'an open channel must clear the handshake watchdog instead of being torn down later')
  })
})
