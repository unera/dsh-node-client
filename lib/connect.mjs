/**
 * Connecting the node to its server: a link from the admin page, or a token by hand.
 *
 * One node serves one server, so a connection has exactly two results: the address
 * becomes the `server` key of the config, and the token goes into the shared
 * credentials file under that address. Both ways — the pairing link and the token
 * typed in by the owner — end there, which is why the wizard and the `connect`
 * command share this function instead of each doing its own bookkeeping.
 *
 * @module dsh-node-client/connect
 */
import { normalizeUrl } from './config.mjs'
import { enrollServer, pairServer } from './runner.mjs'
import { parseConnectUrl } from './api.mjs'

/**
 * @param {object} options
 * @param {{link?: string, server?: string, token?: string}} options.target what to connect to
 * @param {object} options.config settings
 * @param {() => object} options.store store factory
 * @param {(line: string) => void} [options.print] where the progress goes
 * @returns {Promise<string|null>} the address of the server, or null
 */
export async function connectTo ({ target = {}, config = {}, store, print = () => {} }) {
  if (target.link) {
    const withCode = target.link.includes('?')
    const state = withCode
      ? await pairServer({ url: target.link, config, print })
      : await enrollServer({ url: normalizeUrl(target.link), config, print })
    if (!state) return null
    const base = normalizeUrl(withCode ? parseConnectUrl(target.link).base : target.link)
    store().saveSettings({ server: base })
    return base
  }
  if (!target.server) return null
  // a token handed over by the admin: there is nothing to confirm, the address and the
  // token are enough to serve
  const base = normalizeUrl(target.server)
  if (target.token) store().setToken(base, target.token)
  store().saveSettings({ server: base })
  return base
}
