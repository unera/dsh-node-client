/**
 * Исполнитель bash: stdin, разделение stdout/stderr, код возврата, таймаут.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { runBash } from '../lib/bash.mjs'
import { setLang } from '../lib/i18n.mjs'

setLang('en')

test('stdout приходит отдельным блоком', async () => {
  const result = await runBash({ command: 'echo hello' })
  assert.equal(result.ok, true)
  assert.equal(result.results[0].text.trim(), 'hello')
})

test('stderr помечен, чтобы модель не путала потоки', async () => {
  const result = await runBash({ command: 'echo out; echo err >&2' })
  const texts = result.results.map((block) => block.text)
  assert.equal(texts[0].trim(), 'out')
  assert.match(texts[1], /^\[stderr\] err/)
})

test('stdin доезжает до команды', async () => {
  const result = await runBash({ command: 'cat', stdin: 'привет из stdin' })
  assert.equal(result.ok, true)
  assert.match(result.results[0].text, /привет из stdin/)
})

test('пустой stdin закрывает поток, а не висит', async () => {
  const result = await runBash({ command: 'cat; echo done', stdin: '' })
  assert.match(result.results[0].text, /done/)
})

test('код возврата виден в последнем блоке', async () => {
  const result = await runBash({ command: 'exit 7' })
  assert.equal(result.ok, true)
  const meta = JSON.parse(result.results.at(-1).text)
  assert.equal(meta.code, 7)
})
