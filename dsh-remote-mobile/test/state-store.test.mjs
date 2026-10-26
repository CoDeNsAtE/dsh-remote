/**
 * Durable settings/token store tests.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { StateStore, defaultStatePath } from '../lib/state-store.js'

function withTempDir(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-mobile-test-'))
  try {
    return fn(directory)
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {}
  }
}

test('state store persists enablement, listener overrides and rotated token', () => {
  withTempDir(directory => {
    const path = join(directory, 'state.json')
    const store = new StateStore({ path })
    store.load()
    const token = store.resolveToken('')
    assert.ok(token.length >= 32)
    assert.equal(store.resolveToken('configured-token-value'), token)

    store.update({ enabled: true, host: '127.0.0.1', port: 9999, path: '/mobile' })
    const reloaded = new StateStore({ path })
    reloaded.load()
    assert.equal(reloaded.data.enabled, true)
    assert.equal(reloaded.data.host, '127.0.0.1')
    assert.equal(reloaded.data.port, 9999)
    assert.equal(reloaded.data.path, '/mobile')
    assert.equal(reloaded.data.token, token)
    assert.equal(reloaded.resolveToken(''), token)
    statSync(path)
  })
})

test('a corrupt state file degrades to defaults instead of throwing', () => {
  withTempDir(directory => {
    const path = join(directory, 'state.json')
    writeFileSync(path, 'not json at all', 'utf8')
    const errors = []
    const store = new StateStore({ path, logError: message => errors.push(message) })
    store.load()
    assert.equal(store.data.enabled, false)
    assert.ok(store.resolveToken('').length >= 32)
    assert.equal(errors.length, 1)
  })
})

test('default state path lives under DSH_HOME', () => {
  const path = defaultStatePath('C:\\dsh-home')
  assert.match(path, /dsh-home[/\\]dsh-remote-mobile[/\\]state\.json$/)
})
