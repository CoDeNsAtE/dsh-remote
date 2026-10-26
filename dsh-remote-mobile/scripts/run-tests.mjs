#!/usr/bin/env node
/**
 * One-command test runner.
 *
 * `node --test` spawns one child process per file, which some locked-down
 * sandboxes forbid (spawn EPERM). This runner imports every test file into the
 * current process instead, keeping `node:test` semantics and exit codes.
 *
 *   node scripts/run-tests.mjs
 */
import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test')
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()

for (const file of files) {
  await import(pathToFileURL(join(testDir, file)).href)
}
