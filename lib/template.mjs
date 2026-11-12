/**
 * The first settings file of a node: YAML with comments.
 *
 * The template exists so that a human opening `~/.dshnc/config.yaml` for the first
 * time sees what every key means instead of a bare `{}`. That is why the comments
 * live here as text and not in the README: this is where they are read.
 *
 * The file is flat on purpose. A client serves exactly one server, so there is no
 * per-server section to repeat: `server` plus one set of rules. Two nodes means two
 * configs, and `dshnc -c <file>` is how you point at the second one.
 *
 * The rule the wizard follows too: the file is comments plus the real values, never a
 * commented-out example instead of a value — otherwise the client would start with a
 * config that looks configured but is not.
 *
 * @module dsh-node-client/template
 */
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { parseDocument } from 'yaml'

import { t } from './i18n.mjs'

/** Comments are multi-line by nature: every line has to be marked. */
function comment (text) {
  return String(text ?? '').split('\n').map((line) => (line ? `# ${line}` : '#')).join('\n')
}

/** The name a fresh node calls itself: `DSHNC_NAME` wins over the host name. */
export function defaultName () {
  return String(process.env.DSHNC_NAME ?? hostname() ?? 'node').slice(0, 64)
}

/**
 * The template text: comments for every key and the current values.
 *
 * @param {object} [options]
 * @param {string} [options.id] client id
 * @param {string} [options.name] node name
 * @param {string} [options.dir] state directory, shown in the header
 * @returns {string} YAML text
 */
export function settingsTemplate ({ id = randomUUID(), name = defaultName(), dir = '~/.dshnc' } = {}) {
  return [
    comment(t('cfg.header', { dir })),
    '',
    comment(t('cfg.server')),
    'server: null',
    '',
    comment(t('cfg.id')),
    `id: ${id}`,
    '',
    comment(t('cfg.name')),
    `name: ${name}`,
    '',
    comment(t('cfg.aliases')),
    'aliases: []',
    '',
    comment(t('cfg.workdir')),
    'workdir: null',
    '',
    comment(t('cfg.roots')),
    'roots: null',
    '',
    comment(t('cfg.max')),
    'max: rw',
    '',
    comment(t('cfg.base')),
    'base: rw',
    '',
    comment(t('cfg.approver')),
    'approver: none',
    comment(t('cfg.askHint')),
    '',
    comment(t('cfg.ping')),
    'pingInterval: 15',
    '',
    comment(t('cfg.pingFactor')),
    'maxPingIntervalFactor: 10',
    '',
  ].join('\n')
}

/**
 * The template with the given values put in place.
 *
 * Values are set into the parsed document rather than printed into a string: that
 * way an unusual value (a name with `#` in it, a list of roots) stays valid YAML
 * and the comments around it are untouched.
 *
 * @param {object} [values] settings to write into the template
 * @param {object} [options] passed to the template (dir)
 * @returns {string} YAML text
 */
export function renderSettings (values = {}, options = {}) {
  const doc = parseDocument(settingsTemplate({
    id: values.id ?? randomUUID(),
    name: values.name ?? defaultName(),
    ...options,
  }))
  for (const [key, value] of Object.entries(values)) {
    // tokens are not settings and live in credentials.yaml
    if (key === 'servers' || key === 'policy' || value === undefined) continue
    doc.set(key, value)
  }
  return String(doc)
}
