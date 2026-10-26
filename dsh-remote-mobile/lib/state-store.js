/**
 * Small durable state store for the mobile gateway.
 *
 * The profile Loader patch holds the plugin's bootstrap config; this file
 * holds the values the user changes from the settings page at runtime
 * (enablement, listener overrides, rotated token). It lives under DSH_HOME so
 * a Host restart keeps the gateway enabled, and is written with owner-only
 * permissions where the platform supports them.
 *
 * @module dsh-remote-mobile/state-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { generateToken } from './protocol.js'

const STATE_VERSION = 1

/**
 * @param {string} [home] DSH_HOME override (tests).
 * @returns {string} state file path.
 */
export function defaultStatePath(home) {
  const base = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(base, 'dsh-remote-mobile', 'state.json')
}

export class StateStore {
  /**
   * @param {{path?: string, logError?: (message: string) => void}} [options] store options.
   */
  constructor(options = {}) {
    this.path = options.path ?? defaultStatePath()
    this.logError = options.logError ?? (() => {})
    /** @type {{version: number, enabled?: boolean, token?: string, host?: string, port?: number, path?: string}} */
    this.data = { version: STATE_VERSION }
  }

  /** Read the state file, tolerating a missing or corrupt file. */
  load() {
    this.data = { version: STATE_VERSION, enabled: false, token: '' }
    try {
      if (!existsSync(this.path)) {
        return this.data
      }
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('state file is not a JSON object')
      }
      this.data = {
        version: STATE_VERSION,
        enabled: parsed.enabled === true,
        token: typeof parsed.token === 'string' ? parsed.token : '',
        host: typeof parsed.host === 'string' ? parsed.host : undefined,
        port: Number.isSafeInteger(parsed.port) ? parsed.port : undefined,
        path: typeof parsed.path === 'string' ? parsed.path : undefined,
      }
    } catch (error) {
      this.logError(`[dsh-remote-mobile] could not read state file: ${error?.message ?? error}`)
      this.data = { version: STATE_VERSION, enabled: false, token: '' }
    }
    return this.data
  }

  /** Persist the current state atomically. */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.path)
      return true
    } catch (error) {
      this.logError(`[dsh-remote-mobile] could not write state file: ${error?.message ?? error}`)
      return false
    }
  }

  /**
   * Resolve the token: persisted rotation wins, then configured, then a new
   * random token (which is immediately persisted).
   * @param {string} configured configured token from the Loader patch.
   * @returns {string} the effective token.
   */
  resolveToken(configured) {
    const token = this.data.token || String(configured ?? '').trim() || generateToken()
    if (this.data.token !== token) {
      this.data.token = token
      this.save()
    }
    return token
  }

  /**
   * Persist one runtime setting.
   * @param {{enabled?: boolean, host?: string, port?: number, path?: string, token?: string}} patch
   */
  update(patch) {
    for (const key of ['enabled', 'host', 'port', 'path', 'token']) {
      if (patch[key] !== undefined) this.data[key] = patch[key]
    }
    this.save()
  }
}
