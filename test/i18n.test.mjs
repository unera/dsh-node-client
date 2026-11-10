/**
 * Message language: Chinese, English (default) and Russian.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectLang, keys, lang, normalizeLang, setLang, t, table } from '../lib/i18n.mjs'

test('a locale is reduced to a supported language', () => {
  assert.equal(normalizeLang('ru_RU.UTF-8'), 'ru')
  assert.equal(normalizeLang('ru-RU'), 'ru')
  assert.equal(normalizeLang('zh_CN.UTF-8'), 'zh')
  assert.equal(normalizeLang('zh-Hans'), 'zh')
  assert.equal(normalizeLang('en_US'), 'en')
  assert.equal(normalizeLang('de_DE.UTF-8'), null)
  assert.equal(normalizeLang(''), null)
})

test('order of sources: DSHNC_LANG wins over the locale', () => {
  assert.equal(detectLang({ DSHNC_LANG: 'ru', LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US' }), 'ru')
  assert.equal(detectLang({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US' }), 'zh')
  assert.equal(detectLang({ LC_ALL: 'C', LANG: 'ru_RU.UTF-8' }), 'ru')
  assert.equal(detectLang({ LANG: 'POSIX' }), 'en', 'неизвестная локаль — английский')
  assert.equal(detectLang({}), 'en')
})

test('switching the language changes the text', () => {
  setLang('ru')
  assert.match(t('help.help'), /экран/)
  assert.equal(lang(), 'ru')
  setLang('zh')
  assert.match(t('help.help'), /界面/)
  setLang('en')
  assert.match(t('help.help'), /screen/)
})

test('every key exists in all three languages', () => {
  for (const key of keys()) {
    for (const language of ['en', 'ru', 'zh']) {
      assert.ok(table(language)[key], `${language}: нет ключа ${key}`)
    }
  }
})

test('variable substitution and the English fallback', () => {
  setLang('ru')
  assert.equal(t('status.alias', { alias: 'nbw' }), ', узел nbw')
  setLang('xx')
  assert.equal(lang(), 'en', 'неизвестный язык — английский')
  assert.equal(t('нет-такого-ключа'), 'нет-такого-ключа')
})

test('API descriptions are localised too', async () => {
  const { api } = await import('../lib/plugins/shell.mjs')
  setLang('en')
  assert.match(api().description, /Shell/)
  setLang('ru')
  assert.match(api().description, /Shell на машине узла/)
  setLang('zh')
  assert.match(api().methods[0].args.properties.command.description, /命令行/)
  setLang('en')
})
