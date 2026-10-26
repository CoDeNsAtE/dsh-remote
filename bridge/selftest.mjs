#!/usr/bin/env node
/**
 * End-to-end self test for the bridge protocol.
 *
 *   node selftest.mjs
 *
 * It starts the bridge with `mock-acp-agent.mjs`, then drives a complete
 * conversation: new session, prompt, tool approval, transcript, config change,
 * rejection, and session listing.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 18787 + Math.floor(Math.random() * 500)
const TOKEN = 'selftest-token-123'
const URL = `ws://127.0.0.1:${PORT}/dsh`
const workspace = mkdtempSync(join(tmpdir(), 'dsh-bridge-ws-'))
const statePath = join(workspace, '.bridge-state.json')
const mockPath = join(HERE, 'mock-acp-agent.mjs')
const bridgePath = join(HERE, 'dsh-mobile-bridge.mjs')

let bridge = null
let socket = null
let nextId = 1
const pending = new Map()
const events = []
const waiters = new Set()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function log(step, message) {
  console.log(`  ${step.padEnd(4)} ${message}`)
}

function fail(message) {
  throw new Error(message)
}

function rpc(method, params = {}, timeoutMs = 30000) {
  const id = `rpc-${nextId++}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`RPC timeout: ${method}`))
    }, timeoutMs)
    pending.set(id, {
      resolve: value => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: error => {
        clearTimeout(timer)
        reject(error)
      },
    })
    socket.send(JSON.stringify({ type: 'rpc', id, method, params }))
  })
}

function waitForEvent(name, predicate = () => true, start = 0, timeoutMs = 20000) {
  for (let index = start; index < events.length; index += 1) {
    const frame = events[index]
    if (frame.event === name && predicate(frame)) {
      return Promise.resolve({ frame, index })
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(waiter)
      reject(new Error(`Timed out waiting for event: ${name}`))
    }, timeoutMs)
    const waiter = {
      name,
      predicate,
      resolve: value => {
        clearTimeout(timer)
        waiters.delete(waiter)
        resolve(value)
      },
    }
    waiters.add(waiter)
  })
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL)
    socket = ws
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN }))
    })
    ws.on('message', raw => {
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (frame.type === 'hello') {
        clearTimeout(timer)
        resolve(frame)
        return
      }
      if (frame.type === 'auth.error') {
        clearTimeout(timer)
        reject(new Error(frame.message))
        return
      }
      if (frame.type === 'rpc.result') {
        const entry = pending.get(frame.id)
        if (entry) {
          pending.delete(frame.id)
          entry.resolve(frame.result)
        }
        return
      }
      if (frame.type === 'rpc.error') {
        const entry = pending.get(frame.id)
        if (entry) {
          pending.delete(frame.id)
          entry.reject(new Error(frame.error?.message ?? 'RPC failed'))
        }
        return
      }
      if (frame.type === 'event') {
        events.push(frame)
        for (const waiter of [...waiters]) {
          if (waiter.name === frame.event && waiter.predicate(frame)) waiter.resolve({ frame, index: events.length - 1 })
        }
      }
    })
    ws.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function stopBridge() {
  if (socket) {
    try {
      socket.close()
    } catch {
      // Ignore.
    }
  }
  if (bridge && bridge.exitCode === null) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(bridge.pid), '/T', '/F'], { windowsHide: true })
    } else {
      bridge.kill('SIGTERM')
    }
    await sleep(400)
  }
  try {
    rmSync(workspace, { recursive: true, force: true })
  } catch {
    // Ignore.
  }
}

async function main() {
  const command = `"${process.execPath}" "${mockPath}"`
  bridge = spawn(process.execPath, [
    bridgePath,
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--token', TOKEN,
    '--cwd', workspace,
    '--state', statePath,
    '--dsh', command,
  ], {
    cwd: HERE,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let bridgeOutput = ''
  bridge.stdout.on('data', chunk => { bridgeOutput += chunk.toString() })
  bridge.stderr.on('data', chunk => { bridgeOutput += chunk.toString() })

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (bridgeOutput.includes(`ws://127.0.0.1:${PORT}/dsh`)) break
    if (bridge.exitCode !== null) fail(`Bridge exited early:\n${bridgeOutput}`)
    await sleep(100)
  }
  if (!bridgeOutput.includes(`ws://127.0.0.1:${PORT}/dsh`)) {
    fail(`Bridge did not start:\n${bridgeOutput}`)
  }
  log('BOOT', 'bridge started with mock ACP agent')

  const hello = await connect()
  if (hello.name !== 'dsh-mobile-bridge') fail('Unexpected hello payload')
  log('AUTH', 'hello received')

  const initialList = await rpc('sessions.list')
  if (!Array.isArray(initialList.sessions)) fail('sessions.list did not return an array')
  if (initialList.online !== true) fail('mock harness should be online')
  log('LIST', `initial sessions: ${initialList.sessions.length}`)

  const created = await rpc('session.new', {})
  if (!created.session?.sessionId) fail('session.new did not return a session')
  if (!Array.isArray(created.configOptions) || created.configOptions.length !== 2) {
    fail('session.new did not return the expected config options')
  }
  const sessionId = created.session.sessionId
  const cwd = created.session.cwd
  log('NEW', `session ${sessionId}`)

  const opened = await rpc('session.open', { sessionId, cwd })
  if (opened.attached !== true) fail('session.open should attach')
  if (!Array.isArray(opened.items) || opened.items.length !== 0) fail('new session should be empty')
  log('OPEN', 'empty transcript attached')

  const mark = events.length
  const promptPromise = rpc('session.prompt', { sessionId, text: '帮我跑一下测试' }, 60000)
  const running = await waitForEvent('turn.status', frame => frame.sessionId === sessionId && frame.status === 'running', mark)
  if (!running) fail('missing running status')

  const approval = await waitForEvent('approval.request', frame => frame.sessionId === sessionId, mark)
  if (!approval.frame.toolCallId) fail('approval is missing toolCallId')
  if (!String(approval.frame.input).includes('npm test')) fail('approval is missing the tool input')
  log('ASK', `approval for ${approval.frame.label || approval.frame.title}`)

  await rpc('approval.respond', { requestId: approval.frame.requestId, optionId: 'allow-once' })
  const promptResult = await promptPromise
  if (promptResult.stopReason !== 'end_turn') fail(`unexpected stop reason: ${promptResult.stopReason}`)
  await waitForEvent('turn.status', frame => frame.sessionId === sessionId && frame.status === 'idle', mark)
  log('TURN', 'approved tool ran and turn completed')

  const after = await rpc('session.open', { sessionId, cwd })
  const tool = after.items.find(item => item.kind === 'tool')
  const assistant = after.items.find(item => item.kind === 'assistant')
  const thought = after.items.find(item => item.kind === 'thought')
  const user = after.items.find(item => item.kind === 'user')
  if (!tool || tool.status !== 'completed') fail('tool item was not completed')
  if (!String(tool.result).includes('12 tests passed')) fail('tool result missing')
  if (!assistant || !assistant.text.includes('测试已通过')) fail('assistant message missing')
  if (!thought) fail('thought item missing')
  if (!user || user.text !== '帮我跑一下测试') fail('user item missing')
  log('HIST', `transcript: ${after.items.length} items`)

  const modelOption = after.configOptions.find(option => option.id === 'model')
  if (!modelOption || modelOption.choices.length < 2) fail('model choices missing')
  const flash = modelOption.choices.find(choice => choice.name === 'Mock Flash')
  const configured = await rpc('session.setConfig', {
    sessionId,
    configId: 'model',
    value: flash.value,
  })
  const current = configured.configOptions.find(option => option.id === 'model')
  if (current.currentValue !== flash.value) fail('model config did not change')
  log('CONFIG', `model switched to ${flash.name}`)

  const mark2 = events.length
  const promptPromise2 = rpc('session.prompt', { sessionId, text: '跳过测试，直接给我结论' }, 60000)
  const approval2 = await waitForEvent('approval.request', frame => frame.sessionId === sessionId, mark2)
  await rpc('approval.respond', { requestId: approval2.frame.requestId, optionId: '' })
  const promptResult2 = await promptPromise2
  if (promptResult2.stopReason !== 'end_turn') fail('second prompt did not finish')
  const after2 = await rpc('session.open', { sessionId, cwd })
  const tools = after2.items.filter(item => item.kind === 'tool')
  const lastTool = tools[tools.length - 1]
  if (!lastTool || lastTool.status !== 'failed') fail('rejected tool should be marked failed')
  log('REJECT', 'approval rejection is reflected in the tool card')

  const mark3 = events.length
  const promptPromise3 = rpc('session.prompt', { sessionId, text: '再跑一次，但我会取消' }, 60000)
  await waitForEvent('approval.request', frame => frame.sessionId === sessionId, mark3)
  await rpc('session.cancel', { sessionId })
  const promptResult3 = await promptPromise3
  if (promptResult3.stopReason !== 'cancelled') fail(`cancel returned ${promptResult3.stopReason}`)
  await waitForEvent('turn.status', frame => frame.sessionId === sessionId && frame.status === 'idle', mark3)
  log('CANCEL', 'in-flight turn cancelled cleanly')

  const list = await rpc('sessions.list')
  const summary = list.sessions.find(item => item.sessionId === sessionId)
  if (!summary) fail('session is missing from sessions.list')
  if (!summary.title.includes('帮我跑一下测试')) fail(`unexpected title: ${summary.title}`)
  if (!summary.hasTranscript) fail('session summary should have a transcript')
  if (summary.running) fail('session should be idle')
  log('SUMMARY', `${summary.title} · ${summary.preview.slice(0, 30)}…`)

  console.log('\n  ALL CHECKS PASSED\n')
}

main()
  .catch(error => {
    console.error(`\n  SELFTEST FAILED: ${error.message}\n`)
    process.exitCode = 1
  })
  .finally(stopBridge)
