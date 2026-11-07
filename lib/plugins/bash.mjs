/**
 * Устаревшее имя API `shell` (было версией 2).
 *
 * Оставлено, чтобы узлы, к которым модели привыкли ходить через `bash`,
 * продолжали работать после переименования. Новым плагинам и документации
 * нужен `shell`: на Windows за этим именем стоит PowerShell.
 *
 * @module dsh-node-client/plugins/bash
 * @deprecated используйте `shell`
 */
import { t } from '../i18n.mjs'
import { execMethod, handle as shellHandle } from './shell.mjs'

export function api () {
  return {
    name: 'bash',
    version: '2',
    description: t('bash.api.deprecated'),
    methods: [execMethod()],
  }
}

export const handle = shellHandle
