/**
 * Потоки команд: вывод процесса в тело HTTP-запроса и тело ответа в stdin.
 *
 * Решения о том, что считать успехом, живут в lib/pipe.mjs и проверены тестами.
 * Здесь только сеть и процессы.
 *
 * @module dsh-node-client/plugins/pipe-run
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'

import { pipeArgs, pipeOutcome, stderrTail } from '../pipe.mjs'

/** Откуда брать адрес сервера и токен: их кладёт раннер в ctx. */
function endpoint (ctx, route, seq) {
  const server = String(ctx?.server ?? '')
  if (!server) throw Object.assign(new Error('адрес сервера неизвестен: пайп невозможен'), { code: 'no_server' })
  return new URL(`${server.replace(/\/$/, '')}${route}?seq=${seq}`)
}

function requester (url) {
  return url.protocol === 'https:' ? https.request : http.request
}

/** Запустить команду и вернуть управление, когда она закончится. */
function start (args) {
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
  const done = new Promise((resolve) => {
    runner.on('close', (code, signal) => {
      if (timer) clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  return { runner, state, done }
}

/** Узел отдаёт: stdout процесса едет в тело запроса. */
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

  const { runner, state, done } = start(args)
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
    // сервер по этому пути поймёт, что именно финализировать
    pendingPath: `${args.hostPath}.inprogress`,
    results: [{ type: 'text', text: JSON.stringify({ bytes, exitCode: exit.code, stderr: state.stderr }) }],
  }
}

/** Узел принимает: тело ответа едет в stdin процесса. */
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

  const { runner, state, done } = start(args)
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
        // закрываем ввод: скрипт, читающий stdin, иначе будет ждать вечно
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
  // ждём ответ сервера и процесс по отдельности: сначала ответ, потом процесс,
  // иначе kill оказался бы после ожидания, которое сам и не даёт завершиться
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
