/**
 * Behavioural tests of the client wiring: a real loop, a fake server.
 *
 * This checks what used to be "checked" by searching for strings in the source:
 * whether `now` goes into the envelope, whether the line about an orphaned result is written,
 * whether the FLUSH barrier answers through the real pool, whether `client_epoch` gets into
 * the announce, how internal names are routed, and how the epoch protocol recovers from a
 * generation mismatch.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { resolvePlugin } from '../lib/plugins/index.mjs'
import { runServer } from '../lib/runner.mjs'
import { openStore } from '../lib/store.mjs'
import { startFakeNode, waitFor } from './helpers/fake-node.mjs'

const execPlugin = {
  api: { name: 'shell', version: 'test-1', methods: [{ method: 'exec', args: { type: 'object' } }] },
  async handle () {
    await new Promise((resolve) => setTimeout(resolve, 120))
    return { ok: true, results: [{ type: 'text', text: 'готово' }] }
  },
  async handleControl (command, ctx) {
    if (command.method === '#INTERNAL.FLUSH') {
      await ctx.drain?.()
      return { ok: true, results: [{ type: 'text', text: JSON.stringify({ flushed: true }) }] }
    }
    return { ok: true, results: [] }
  },
}

/**
 * Bring up the client against the fake server and make sure everything is torn down.
 * @param {object} options fake server options
 * @param {(fake: object, client: {printed: string[]}) => Promise<void>} body the check
 */
async function withNode (options, body) {
  const fake = await startFakeNode(options)
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-behaviour-'))
  const previousHome = process.env.DSHNC_HOME
  process.env.DSHNC_HOME = dir
  const store = openStore()
  store.setToken(fake.url, 'test-token')
  const controller = new AbortController()
  const printed = []
  const run = runServer({
    url: fake.url,
    config: { token: 'test-token' },
    print: (line) => printed.push(line),
    signal: controller.signal,
    plugins: [execPlugin],
  })
  try {
    await body(fake, { printed, store, url: fake.url })
  } finally {
    controller.abort()
    // stopping the client must not hang the test: if run did not finish within 5 s,
    // that is a client defect and must be reported, not hang until the CI timeout
    const stopped = await Promise.race([
      run.then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!stopped) {
      assert.fail(`клиент не остановился по abort за 5 секунд; последнее в логе: ${printed.slice(-3).join(' | ')}`)
    }
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
}

test('result envelope carries the node clock', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.results.length > 0), 'клиент должен отправить результат')
    assert.equal(typeof fake.calls.results[0].body.now, 'number', 'часы узла едут в конверте, а не в тексте')
    // the connection counter travels in the announce: it is how the server keeps one
    // connection out of two
    assert.equal(typeof fake.calls.announces[0]?.client_epoch, 'number', 'счётчик соединения нужен серверу')
  })
})

test('orphaned result goes to the log instead of being lost silently', async () => {
  await withNode({
    commands: [{ seq: 2, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
    resultStatus: 409,
  }, async (fake, client) => {
    assert.ok(
      await waitFor(() => client.printed.some((line) => /\b2\b/.test(line) && /осиротел|orphaned/i.test(line))),
      `ожидали строку про осиротевшую команду, а в логе: ${client.printed.join(' | ')}`,
    )
  })
})

test('FLUSH barrier answers through the real pool and does not lock itself up', async () => {
  await withNode({
    commands: [
      { seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } },
      { seq: 2, api: -1, method: '#INTERNAL.FLUSH', args: {}, timeout: 10, sandbox: { mode: 'rw' } },
    ],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.results.length >= 2), 'обе команды должны ответить')
    const flush = fake.calls.results.find((entry) => entry.seq === 2)
    assert.ok(flush, 'барьер обязан ответить, а не висеть на себе')
    assert.equal(flush.body.ok, true)
    const flushAt = fake.calls.results.findIndex((entry) => entry.seq === 2)
    const execAt = fake.calls.results.findIndex((entry) => entry.seq === 1)
    assert.ok(flushAt > execAt, 'барьер отвечает после работы, а не раньше')
  })
})

test('internal name goes to handleControl, ordinary one to handle', () => {
  const other = { api: { name: 'other', methods: [{ method: 'plain' }] }, async handle () { return { ok: true } } }
  const plugins = [execPlugin, other]
  assert.equal(resolvePlugin(plugins, { method: '#INTERNAL.CANCEL', api: -1 }), execPlugin, 'решётка — всегда служебный обработчик')
  assert.equal(resolvePlugin(plugins, { method: 'exec', api: 1 }, { shell: 1 }), execPlugin, 'обычное имя — по объявлению')
})

test('socket drop does not turn into polling: the client reconnects', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.sockets >= 1), 'клиент должен открыть сокет')
    // the server drops the socket - the client must open a new one, not start polling
    fake.dropSockets()
    assert.ok(
      await waitFor(() => fake.calls.sockets >= 2, { timeoutMs: 6000 }),
      'после разрыва клиент должен переподключиться',
    )
  })
})

test('retry after an error keeps the pause instead of spinning per socket frame', async () => {
  // First the server is alive: the client announces itself and holds the socket. Then the "proxy"
  // starts serving 404 HTML and drops the connection - that is when the old code
  // (a pause interrupted by a socket frame) went into a tight loop.
  await withNode({}, async (fake, client) => {
    assert.ok(await waitFor(() => fake.calls.sockets >= 1), 'клиент должен подключиться')

    const brokenAt = Date.now()
    fake.breakHttp()
    fake.dropSockets()

    // wait until several attempts have accumulated after the breakage
    await waitFor(() => fake.calls.requests.filter((entry) => entry.at > brokenAt).length >= 3, { timeoutMs: 12_000 })
    const attempts = fake.calls.requests.filter((entry) => entry.at > brokenAt).map((entry) => entry.at)
    assert.ok(attempts.length >= 2, `ожидали повторы, а их ${attempts.length}`)

    // no pause may be shorter than a second: backoff goes 1 -> 2 -> 4 s
    const gaps = attempts.slice(1).map((at, index) => at - attempts[index])
    for (const gap of gaps) {
      assert.ok(gap >= 800, `пауза не выдержана: ${gaps.join(', ')} мс`)
    }
    // and the pause must GROW. The old code (a pause interrupted by a socket frame)
    // also gave ~1 s between attempts, but never lengthened it; measured:
    // the new one - 1029 and 2029 ms, the old one - 1017, 1034, 1020, 1023...
    assert.ok(
      Math.max(...gaps) >= 1500,
      `backoff должен удлинять паузу, а интервалы: ${gaps.join(', ')} мс`,
    )
    assert.ok(gaps.length <= 3, `за это время попыток больше, чем велит backoff: ${gaps.join(', ')} мс`)
    assert.ok(
      client.printed.some((line) => /ответ не JSON|not JSON/i.test(line)),
      `в логе должно быть сказано про не-JSON ответ, а там: ${client.printed.join(' | ')}`,
    )
  })
})

test('401 without JSON does not wipe the node token', async () => {
  // nginx basic-auth or Cloudflare answer with 401 HTML: this is not "the token is wrong",
  // and the pairing must not be lost because of a proxy
  const fake = await startFakeNode({})
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-401-'))
  const previousHome = process.env.DSHNC_HOME
  process.env.DSHNC_HOME = dir
  const store = openStore()
  store.setToken(fake.url, 'secret-token')
  // the server answers 401 HTML to everything (this is how basic-auth behaves behind a proxy)
  fake.breakHttp(401)
  const controller = new AbortController()
  const printed = []
  const run = runServer({ url: fake.url, config: { token: 'secret-token' }, print: (line) => printed.push(line), signal: controller.signal, plugins: [execPlugin] })
  try {
    await waitFor(() => printed.length > 0, { timeoutMs: 5000 })
    assert.equal(store.token(fake.url), 'secret-token', 'токен должен остаться: 401 от прокси — не отказ узла')
  } finally {
    controller.abort()
    // stopping the client must not hang the test: if run did not finish within 5 s,
    // that is a client defect and must be reported, not hang until the CI timeout
    const stopped = await Promise.race([
      run.then(() => true).catch(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ])
    if (!stopped) assert.fail('клиент не остановился по abort за 5 секунд')
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the client speaks the epoch protocol: client_epoch in the announce and in commands', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
  }, async (fake) => {
    assert.ok(await waitFor(() => fake.calls.results.length > 0), 'the client must execute the command')

    const ann = fake.calls.announces[0]
    assert.ok(ann, 'the client must announce itself')
    assert.equal(typeof ann.client_epoch, 'number', 'the connection counter travels in the announce')
    assert.ok('epoch' in ann, 'the announce names the generation the client knows')
    assert.equal(ann.epoch, null, 'a fresh state file knows no generation')
    assert.equal(ann.known, undefined, 'known is gone from the announce')
    assert.equal(ann.proto, undefined, 'proto is gone from the announce')
    assert.equal(ann.max_commandno, undefined, 'the announce reports no command number')
    assert.equal(typeof ann.platform, 'string', 'the platform is named separately from the version')

    const paths = new Set(fake.calls.requests.map((entry) => entry.path))
    assert.ok(![...paths].some((path) => path.endsWith('/v1/state')), `GET /v1/state is gone from the protocol: ${[...paths].join(', ')}`)

    const query = fake.calls.commandQueries[0]
    assert.ok(query, 'the client must ask for commands')
    assert.equal(query.client_epoch, String(ann.client_epoch), 'commands carry the same connection counter')
    assert.equal(query.epoch, '1', 'commands carry the generation the server named')

    for (const frame of fake.calls.frames) {
      assert.ok(['state', 'ping'].includes(frame.t), `unexpected frame ${frame.t}`)
      assert.equal(frame.known, undefined, 'known is gone from the frames')
      assert.equal(frame.proto, undefined, 'proto is gone from the frames')
    }
    const wait = fake.calls.frames.find((frame) => frame.t === 'state')
    assert.ok(wait, 'the client declares that it is waiting')
    assert.equal(wait.epoch, 1, 'the wait frame carries the generation')
    assert.equal(wait.client_epoch, ann.client_epoch, 'the wait frame carries the connection counter too')
    assert.equal(typeof wait.max_commandno, 'number', 'the wait frame carries the executed number')
  })
})

test('epoch-mismatch on commands resets the epoch and starts over from the announce', async () => {
  await withNode({ bumpOnAnnounce: true, commandErrors: ['epoch-mismatch'] }, async (fake, client) => {
    assert.ok(
      await waitFor(() => fake.calls.announces.length >= 2, { timeoutMs: 6000 }),
      `the client must announce again; log: ${client.printed.join(' | ')}`,
    )
    assert.equal(fake.calls.announces[0].epoch, null, 'the first announce knows no generation')
    assert.equal(fake.calls.announces[1].epoch, null, 'the epoch is reset to null before the new announce')
    assert.ok(
      fake.calls.announces[1].client_epoch > fake.calls.announces[0].client_epoch,
      'the connection counter grows with the new generation',
    )
    assert.ok(
      await waitFor(() => client.store.readState(client.url).epoch === fake.epoch()),
      `the new generation must be adopted, got ${client.store.readState(client.url).epoch}, expected ${fake.epoch()}`,
    )
  })
})

test('a socket closed with 4409 resets the epoch and starts over from the announce', async () => {
  await withNode({ bumpOnAnnounce: true, closeOnConnect: [4409] }, async (fake, client) => {
    assert.ok(
      await waitFor(() => fake.calls.announces.length >= 2, { timeoutMs: 6000 }),
      `a 4409 close must lead to a new announce; log: ${client.printed.join(' | ')}`,
    )
    assert.equal(fake.calls.announces[1].epoch, null, 'the epoch is reset to null before the new announce')
    assert.ok(await waitFor(() => fake.calls.sockets >= 2), 'a fresh socket is opened')
    assert.ok(
      await waitFor(() => client.store.readState(client.url).epoch === fake.epoch()),
      `the new generation must be adopted, got ${client.store.readState(client.url).epoch}, expected ${fake.epoch()}`,
    )
  })
})

test('max_commandno named by the server is accepted, from the frame as well as from the batch', async () => {
  await withNode({
    commands: [{ seq: 1, api: 1, method: 'exec', args: {}, timeout: 10, sandbox: { mode: 'rw' } }],
    // the number the server names is a fact about its queue: numbers spent before this
    // process started are never handed out again, so a client that counts only its own
    // batch can never catch up — the server answers every `state` with another one
    pushState: { max_commandno: 9999 },
  }, async (fake, client) => {
    assert.ok(await waitFor(() => fake.calls.results.length > 0), 'the client must execute the command')
    const sent = () => fake.calls.frames.filter((frame) => frame.t === 'state').map((frame) => frame.max_commandno)
    // the claim is the maximum of "what I executed" and "what the server named": the frame
    // arrives before the batch, so 9999 wins and 1 is never reported on its own
    assert.ok(
      await waitFor(() => sent().includes(9999), { timeoutMs: 4000 }),
      `the server number must be adopted from the frame; frames: ${sent().join(', ')} (log: ${client.printed.join(' | ')})`,
    )
    // and the claim never falls back: every later frame keeps the adopted number
    assert.ok(sent().at(-1) === 9999, `the claim must not go backwards: ${sent().join(', ')}`)
  })
})

test('a connection replaced by a newer instance makes the client exit instead of fighting', async () => {
  // 4001 `replaced` means "another instance of this node is newer": reconnecting would make
  // two daemons push each other out and raise `client_epoch` forever, so the client leaves
  // with code 0 — a service manager must not restart such an exit.
  const fake = await startFakeNode({ closeOnConnect: [{ code: 4001, reason: 'replaced' }] })
  const dir = mkdtempSync(join(tmpdir(), 'dshnc-replaced-'))
  const previousHome = process.env.DSHNC_HOME
  process.env.DSHNC_HOME = dir
  openStore().setToken(fake.url, 'test-token')
  // the exit is a process-wide act: the check has to run in a child, exactly like a daemon
  const runnerUrl = fileURLToPath(new URL('../lib/runner.mjs', import.meta.url))
  const script = join(dir, 'daemon.mjs')
  writeFileSync(script, `import { runServer } from ${JSON.stringify(runnerUrl)}
runServer({ url: ${JSON.stringify(fake.url)}, config: { token: 'test-token' }, print: (line) => console.log(line), plugins: [] })
  .catch((error) => { console.error(String(error)); process.exit(2) })
`)
  const child = spawn(process.execPath, [script], { env: { ...process.env, DSHNC_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  const status = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('timeout')
    }, 15000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  try {
    assert.equal(status, 0, `the replaced instance must exit with code 0, got ${status}: ${out}`)
    assert.match(out, /replaced by a newer instance|вытеснено более новым/, `the reason must reach the log: ${out}`)
  } finally {
    await fake.close().catch(() => {})
    if (previousHome === undefined) delete process.env.DSHNC_HOME
    else process.env.DSHNC_HOME = previousHome
    rmSync(dir, { recursive: true, force: true })
  }
})
