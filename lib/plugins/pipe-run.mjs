/**
 * Command streams: process output into the body of an HTTP request, and the
 * response body into stdin.
 *
 * Decisions about what counts as success live in lib/pipe.mjs and are covered by
 * tests. Only the network and the processes are here.
 *
 * @module dsh-node-client/plugins/pipe-run
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

import { pipeArgs, pipeOutcome, stderrTail } from '../pipe.mjs'

/** Registry shared with `exec`: cancellation finds the process by command number. */
export { cancelRunning } from '../running.mjs'
import { forgetRunning, registerRunning } from '../running.mjs'

/** Where the server address and the token come from: the runner puts them in ctx. */
function endpoint (ctx, route, seq) {
  const server = String(ctx?.server ?? '')
  if (!server) throw Object.assign(new Error('адрес сервера неизвестен: пайп невозможен'), { code: 'no_server' })
  return new URL(`${server.replace(/\/$/, '')}${route}?seq=${seq}`)
}

function requester (url) {
  return url.protocol === 'https:' ? https.request : http.request
}

/** Start the command and return control when it finishes. */
function start (args, seq = null) {
  const runner = spawn('/bin/sh', ['-c', args.command], {
    cwd: args.cwd ?? undefined,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = { stderr: '', timedOut: false, killed: false }
  runner.stderr.on('data', (chunk) => {
    state.stderr = stderrTail(state.stderr + chunk.toString())
  })
  const timer = args.timeoutMs > 0
    ? setTimeout(() => {
      state.timedOut = true
      runner.kill('SIGKILL')
    }, args.timeoutMs)
    : null
  if (timer && typeof timer.unref === 'function') timer.unref()
  registerRunning(seq, { kill: () => runner.kill('SIGKILL') })
  const done = new Promise((resolve) => {
    runner.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      forgetRunning(seq)
      resolve({ code, signal })
    })
  })
  return { runner, state, done }
}

/** The node gives: the process's stdout goes into the request body. */
export async function pipeFrom (command, ctx) {
  let args
  try {
    args = pipeArgs(command.args, 'from')
  } catch (error) {
    return { ok: false, code: error.code ?? 'bad_args', message: error.message }
  }
  let url
  try {
    url = endpoint(ctx, '/v1/upload-file', command.seq)
  } catch (error) {
    return { ok: false, code: error.code ?? 'no_server', message: error.message }
  }

  const { runner, state, done } = start(args, command.seq)
  let bytes = 0
  runner.stdout.on('data', (chunk) => { bytes += chunk.length })
  const req = requester(url)(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx?.token ?? ''}`,
      'content-type': 'application/octet-stream',
    },
  })
  const answered = new Promise((resolve) => {
    req.on('response', (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', (error) => resolve({ error }))
  })
  runner.stdout.pipe(req)
  runner.stdout.on('error', () => {})
  const [exit, answer] = await Promise.all([done, answered])

  if (answer?.error || answer.status !== 200) {
    runner.kill('SIGKILL')
  }
  if (answer?.error) {
    return { ok: false, code: 'transfer_failed', message: `поток не дошёл до сервера: ${answer.error.message}` }
  }
  if (answer.status !== 200) {
    return { ok: false, code: `http_${answer.status}`, message: `сервер отказал (${answer.status})` }
  }
  const verdict = pipeOutcome({
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: state.timedOut,
    bytes,
    stderrTail: state.stderr,
  }, 'from')
  return {
    ok: verdict.ok,
    code: verdict.code,
    message: verdict.message,
    // through this path the server understands what exactly to finalize
    pendingPath: `${args.hostPath}.inprogress`,
    results: [{ type: 'text', text: JSON.stringify({ bytes, exitCode: exit.code, stderr: state.stderr }) }],
  }
}

/** The node takes: the response body goes into the process's stdin. */
export async function pipeTo (command, ctx) {
  let args
  try {
    args = pipeArgs(command.args, 'to')
  } catch (error) {
    return { ok: false, code: error.code ?? 'bad_args', message: error.message }
  }
  let url
  try {
    url = endpoint(ctx, '/v1/download-file', command.seq)
  } catch (error) {
    return { ok: false, code: error.code ?? 'no_server', message: error.message }
  }

  const { runner, state, done } = start(args, command.seq)
  runner.stdin.on('error', () => {})
  let bytes = 0
  const req = requester(url)(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx?.token ?? ''}`, 'content-length': '0' },
  })
  const answered = new Promise((resolve) => {
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        // close the input: a script reading stdin would otherwise wait forever
        try {
          runner.stdin.end()
        } catch {}
        resolve({ status: res.statusCode })
        return
      }
      res.on('data', (chunk) => { bytes += chunk.length })
      res.pipe(runner.stdin)
      res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', (error) => resolve({ error }))
  })
  req.end()
  // wait for the server's answer and for the process separately: the answer first,
  // then the process, otherwise the kill would end up after a wait that it itself
  // prevents from finishing
  const answer = await answered
  if (answer?.error || answer.status !== 200) {
    try {
      runner.stdin.end()
    } catch {}
    runner.kill('SIGKILL')
  }
  const exit = await done
  if (answer?.error) {
    return { ok: false, code: 'transfer_failed', message: `данные не пришли с сервера: ${answer.error.message}` }
  }
  if (answer.status !== 200) {
    return { ok: false, code: `http_${answer.status}`, message: `сервер отказал (${answer.status})` }
  }
  const verdict = pipeOutcome({
    exitCode: exit.code,
    signal: exit.signal,
    timedOut: state.timedOut,
    bytes,
    stderrTail: state.stderr,
  }, 'to')
  return {
    ok: verdict.ok,
    code: verdict.code,
    message: verdict.message,
    results: [{ type: 'text', text: JSON.stringify({ bytes, exitCode: exit.code, stderr: state.stderr }) }],
  }
}
