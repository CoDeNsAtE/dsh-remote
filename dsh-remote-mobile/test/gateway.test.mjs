/**
 * Protocol gateway tests: auth, RPC dispatch, events, approvals, multi-client
 * broadcast, reconnect replay, token rotation, port conflicts and frame limits.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import WebSocketPackage from '../vendor/ws/index.js'
import { MobileGateway } from '../lib/gateway.js'
import {
  MockBridge,
  PhoneClient,
  TOKEN,
  sessionSummary,
  sleep,
  startGateway,
  waitFor,
} from './helpers.mjs'

const WebSocket = WebSocketPackage

async function withGateway(fn, gatewayOptions = {}) {
  const bridge = new MockBridge()
  const { gateway, url, close } = await startGateway(bridge, { gateway: gatewayOptions })
  try {
    return await fn({ bridge, gateway, url })
  } finally {
    await close()
  }
}

test('auth success returns hello and answers ping/server.info', async () => {
  await withGateway(async ({ url }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    const hello = client.frames.find(frame => frame.type === 'hello')
    assert.equal(hello.name, 'dsh-remote-mobile')
    assert.equal(hello.version, '0.1.0')
    assert.equal(hello.path, '/dsh')
    assert.equal(hello.workspace, 'C:\\mock-workspace')
    assert.equal(hello.defaultCwd, 'C:\\mock-workspace')
    assert.equal(hello.online, true)
    assert.equal(hello.agent.name, 'deepseek-harness')

    const pong = await client.ping()
    assert.equal(typeof pong.time, 'number')

    const info = await client.rpc('server.info')
    assert.equal(info.name, 'dsh-remote-mobile')
    assert.equal(info.path, '/dsh')
    client.close()
  })
})

test('wrong token returns auth.error and closes 4401', async () => {
  await withGateway(async ({ url }) => {
    const client = await PhoneClient.connectExpectAuthError(url, 'wrong-token-0000000000')
    assert.equal(client.authError, '访问令牌不正确')
    await waitFor(() => client.closed, 2000, 'close after auth error')
    assert.equal(client.closed.code, 4401)
  })
})

test('unauthenticated connection closes after the auth timeout', async () => {
  await withGateway(async ({ url }) => {
    const client = new PhoneClient()
    await client.openSocket(url)
    await waitFor(() => client.frames.some(frame => frame.type === 'auth.error'), 3000, 'auth timeout frame')
    await waitFor(() => client.closed, 3000, 'close after auth timeout')
    assert.equal(client.closed.code, 4401)
  }, { authTimeoutMs: 120 })
})

test('a non-configured path is rejected at the upgrade', async () => {
  await withGateway(async ({ gateway }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/not-dsh`)
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 3000)
      socket.on('open', () => {
        clearTimeout(timer)
        resolve('open')
      })
      socket.on('error', () => {
        clearTimeout(timer)
        resolve('error')
      })
      socket.on('close', () => {
        clearTimeout(timer)
        resolve('close')
      })
    })
    assert.notEqual(outcome, 'open')
    assert.notEqual(outcome, 'timeout')
    try {
      socket.close()
    } catch {}
  })
})

test('RPC errors use the frozen code vocabulary and echo string ids', async () => {
  await withGateway(async ({ url }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    const unknown = await client.rpcError('does.notExist')
    assert.equal(unknown.code, -32601)
    const missing = await client.rpcError('session.open', {})
    assert.equal(missing.code, -32602)
    const invalidConfig = await client.rpcError('session.setConfig', { sessionId: 'session-1', configId: 'temperature', value: '1' })
    assert.equal(invalidConfig.code, -32602)

    const id = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 3000)
      const rpcId = 'custom-string-id'
      client.socket.send(JSON.stringify({ type: 'rpc', id: rpcId, method: 'ping', params: {} }))
      client.waitFrame(frame => frame.type === 'rpc.result' && frame.id === rpcId, 3000).then(frame => {
        clearTimeout(timer)
        resolve(frame.id)
      }, reject)
    })
    assert.equal(id, 'custom-string-id')
    client.close()
  })
})

test('sessions.list / session.new / session.open dispatch and mark phone-opened sessions', async () => {
  await withGateway(async ({ url, bridge }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    const list = await client.rpc('sessions.list')
    assert.equal(list.online, true)
    assert.equal(list.warning, '')
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].sessionId, 'session-1')

    const created = await client.rpc('session.new', { cwd: 'C:\\mock-workspace' })
    assert.equal(created.session.title, '新会话')
    assert.equal(created.configOptions.length, 2)
    const newId = created.session.sessionId
    await waitFor(() => bridge.watched.get(newId) === true, 2000, 'new session watched')

    const opened = await client.rpc('session.open', { sessionId: 'session-1', cwd: 'C:\\mock-workspace' })
    assert.equal(opened.attached, true)
    assert.ok(Array.isArray(opened.items))
    assert.equal(bridge.watched.get('session-1'), true)
    client.close()
  })
})

test('session.open passes attached=false + warning through', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.openAttached = false
    bridge.openWarning = '会话被其他进程占用'
    const client = await PhoneClient.connect(url, TOKEN)
    const opened = await client.rpc('session.open', { sessionId: 'session-1', cwd: '' })
    assert.equal(opened.attached, false)
    assert.equal(opened.warning, '会话被其他进程占用')
    client.close()
  })
})

test('prompt streams item events and turn.status, then resolves', async () => {
  await withGateway(async ({ url }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    const mark = client.frames.length
    const result = await client.rpc('session.prompt', { sessionId: 'session-1', text: '你好' })
    assert.equal(result.stopReason, 'end_turn')
    await waitFor(() => client.frames.slice(mark).some(frame => frame.event === 'item.upsert'), 2000, 'item.upsert')
    const statuses = client.frames
      .filter(frame => frame.type === 'event' && frame.event === 'turn.status')
      .map(frame => frame.status)
    assert.ok(statuses.includes('running'))
    assert.ok(statuses.includes('idle'))
    client.close()
  })
})

test('prompt rejects a second in-flight prompt on the same session', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      await gateway.requestApproval({ sessionId: 'session-1', toolCallId: 'c1', title: 'bash', label: '终端命令', input: 'echo hi' })
    }
    const client = await PhoneClient.connect(url, TOKEN)
    const first = client.rpc('session.prompt', { sessionId: 'session-1', text: 'first' })
    const approval = await client.waitEvent('approval.request')
    const second = await client.rpcError('session.prompt', { sessionId: 'session-1', text: 'second' })
    assert.equal(second.code, -32603)
    assert.match(second.message, /正在执行/)
    await client.rpc('approval.respond', { requestId: approval.requestId, optionId: 'allow-once' })
    assert.equal((await first).stopReason, 'end_turn')
    client.close()
  })
})

test('session.cancel cancels the bridge turn and pending approvals', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      await gateway.requestApproval({ sessionId: 'session-1', toolCallId: 'c1', title: 'bash', label: '终端命令', input: 'sleep 30' })
    }
    const client = await PhoneClient.connect(url, TOKEN)
    const prompted = client.rpc('session.prompt', { sessionId: 'session-1', text: 'run' })
    const approval = await client.waitEvent('approval.request')
    await client.rpc('session.cancel', { sessionId: 'session-1' })
    const resolved = await client.waitEvent('approval.resolved', frame => frame.requestId === approval.requestId)
    assert.equal(resolved.decision, 'cancelled')
    assert.equal((await prompted).stopReason, 'end_turn')
    assert.deepEqual(bridge.cancelled, ['session-1'])
    client.close()
  })
})

test('session.setConfig validates ids and returns the complete option state', async () => {
  await withGateway(async ({ url, bridge }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    const value = JSON.stringify(['mock-provider', 'mock-pro'])
    const result = await client.rpc('session.setConfig', { sessionId: 'session-1', configId: 'model', value })
    assert.equal(result.configOptions.find(option => option.id === 'model').currentValue, value)
    assert.deepEqual(bridge.configChanges[0], { sessionId: 'session-1', configId: 'model', value })
    const update = await client.waitEvent('config.updated')
    assert.equal(update.sessionId, 'session-1')
    client.close()
  })
})

test('approval allow-once resolves allowed and broadcasts approval.resolved', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      bridge.outcomes.push(await gateway.requestApproval({
        sessionId: 'session-1', toolCallId: 'call-1', title: 'bash', label: '终端命令', input: 'npm test',
      }))
    }
    const client = await PhoneClient.connect(url, TOKEN)
    const prompted = client.rpc('session.prompt', { sessionId: 'session-1', text: 'run tests' })
    const request = await client.waitEvent('approval.request')
    assert.equal(request.sessionId, 'session-1')
    assert.equal(request.toolCallId, 'call-1')
    assert.equal(request.label, '终端命令')
    assert.deepEqual(request.options.map(option => option.optionId), ['allow-once', 'reject-once'])
    assert.deepEqual(request.options.map(option => option.kind), ['allow_once', 'reject_once'])

    const responded = await client.rpc('approval.respond', { requestId: request.requestId, optionId: 'allow-once' })
    assert.deepEqual(responded, { ok: true })
    const resolved = await client.waitEvent('approval.resolved')
    assert.equal(resolved.decision, 'selected')
    assert.equal(resolved.optionId, 'allow-once')
    assert.equal(resolved.requestId, request.requestId)
    assert.equal((await prompted).stopReason, 'end_turn')
    assert.deepEqual(bridge.outcomes, ['allowed-once'])
    client.close()
  })
})

test('approval reject-once resolves rejected; invalid and duplicate responses fail', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      bridge.outcomes.push(await gateway.requestApproval({
        sessionId: 'session-1', toolCallId: 'call-2', title: 'bash', label: '终端命令', input: 'rm -rf build',
      }))
    }
    const client = await PhoneClient.connect(url, TOKEN)
    const prompted = client.rpc('session.prompt', { sessionId: 'session-1', text: 'clean' })
    const request = await client.waitEvent('approval.request')
    const invalid = await client.rpcError('approval.respond', { requestId: request.requestId, optionId: 'allow-always' })
    assert.equal(invalid.code, -32602)
    await client.rpc('approval.respond', { requestId: request.requestId, optionId: 'reject-once' })
    const duplicate = await client.rpcError('approval.respond', { requestId: request.requestId, optionId: 'reject-once' })
    assert.equal(duplicate.code, -32603)
    assert.equal((await prompted).stopReason, 'end_turn')
    assert.deepEqual(bridge.outcomes, ['rejected'])
    const resolved = client.events('approval.resolved').at(-1)
    assert.equal(resolved.decision, 'selected')
    client.close()
  })
})

test('an unanswered approval times out as cancelled', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      bridge.outcomes.push(await gateway.requestApproval({
        sessionId: 'session-1', toolCallId: 'call-3', title: 'bash', label: '终端命令', input: 'sleep',
      }))
    }
    const client = await PhoneClient.connect(url, TOKEN)
    const prompted = client.rpc('session.prompt', { sessionId: 'session-1', text: 'wait' })
    await client.waitEvent('approval.request')
    await waitFor(() => bridge.outcomes.length === 1, 3000, 'approval timeout')
    assert.deepEqual(bridge.outcomes, ['cancelled'])
    const resolved = await client.waitEvent('approval.resolved', frame => frame.reason === 'timeout')
    assert.equal(resolved.decision, 'cancelled')
    assert.equal((await prompted).stopReason, 'end_turn')
    client.close()
  }, { approvalTimeoutMs: 150 })
})

test('pending approvals are replayed to a reconnecting client', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      bridge.outcomes.push(await gateway.requestApproval({
        sessionId: 'session-1', toolCallId: 'call-4', title: 'bash', label: '终端命令', input: 'echo replay',
      }))
    }
    const first = await PhoneClient.connect(url, TOKEN)
    const prompted = first.rpc('session.prompt', { sessionId: 'session-1', text: 'replay' })
    void prompted.catch(() => {})
    const request = await first.waitEvent('approval.request')
    first.close()
    await sleep(50)

    const second = await PhoneClient.connect(url, TOKEN)
    const replayed = await second.waitEvent('approval.request', frame => frame.requestId === request.requestId)
    assert.equal(replayed.input, 'echo replay')
    await second.rpc('approval.respond', { requestId: replayed.requestId, optionId: 'allow-once' })
    await waitFor(() => bridge.outcomes.length === 1, 3000, 'replayed approval outcome')
    assert.deepEqual(bridge.outcomes, ['allowed-once'])
    // A fresh prompt from the reconnected client still works after the replay.
    bridge.onPrompt = undefined
    const replayedPrompt = await second.rpc('session.prompt', { sessionId: 'session-1', text: 'after replay' })
    assert.equal(replayedPrompt.stopReason, 'end_turn')
    second.close()
  })
})

test('all authenticated clients receive the same events; first approval answer wins', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      bridge.outcomes.push(await gateway.requestApproval({
        sessionId: 'session-1', toolCallId: 'call-5', title: 'bash', label: '终端命令', input: 'echo both',
      }))
    }
    const phone = await PhoneClient.connect(url, TOKEN)
    const tablet = await PhoneClient.connect(url, TOKEN)
    const prompted = phone.rpc('session.prompt', { sessionId: 'session-1', text: 'broadcast' })
    const request = await phone.waitEvent('approval.request')
    const tabletRequest = await tablet.waitEvent('approval.request', frame => frame.requestId === request.requestId)
    assert.equal(tabletRequest.requestId, request.requestId)

    await tablet.rpc('approval.respond', { requestId: request.requestId, optionId: 'reject-once' })
    await phone.waitEvent('approval.resolved', frame => frame.requestId === request.requestId)
    const late = await phone.rpcError('approval.respond', { requestId: request.requestId, optionId: 'allow-once' })
    assert.equal(late.code, -32603)
    assert.equal((await prompted).stopReason, 'end_turn')
    assert.deepEqual(bridge.outcomes, ['rejected'])
    phone.close()
    tablet.close()
  })
})

test('rotating the token disconnects existing clients and only the new token works', async () => {
  await withGateway(async ({ url, gateway }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    const next = 'rotated-token-0123456789abcdefghijklmn'
    gateway.rotateToken(next)
    await waitFor(() => client.closed, 3000, 'close after rotation')
    assert.equal(client.closed.code, 4401)

    const stale = await PhoneClient.connectExpectAuthError(url, TOKEN)
    assert.equal(stale.authError, '访问令牌不正确')

    const fresh = await PhoneClient.connect(url, next)
    assert.equal(fresh.frames.some(frame => frame.type === 'hello'), true)
    fresh.close()
    stale.close()
  })
})

test('a busy port reports an error without crashing the first gateway', async () => {
  const bridge = new MockBridge()
  const { gateway, url, close } = await startGateway(bridge)
  try {
    const conflicting = new MobileGateway({
      bridge,
      config: { host: '127.0.0.1', port: gateway.port, path: '/dsh', token: TOKEN },
      log: () => {},
      logError: () => {},
    })
    const started = await conflicting.start()
    assert.equal(started, false)
    assert.match(conflicting.lastError, /占用|无法启动/)
    const client = await PhoneClient.connect(url, TOKEN)
    await client.ping()
    client.close()
    await conflicting.stop()
  } finally {
    await close()
  }
})

test('a frame above 1MB closes the connection and the server stays healthy', async () => {
  await withGateway(async ({ url }) => {
    const client = await PhoneClient.connect(url, TOKEN)
    client.socket.send(JSON.stringify({ type: 'rpc', id: 'huge', method: 'ping', params: { blob: 'x'.repeat(1024 * 1024 + 100) } }))
    await waitFor(() => client.closed, 5000, 'close after oversized frame')
    assert.ok([1009, 1008, 1006].includes(client.closed.code), `unexpected close code ${client.closed.code}`)
    const fresh = await PhoneClient.connect(url, TOKEN)
    await fresh.ping()
    fresh.close()
  })
})

test('approvals are cancelled after all clients stay disconnected', async () => {
  await withGateway(async ({ url, bridge }) => {
    bridge.onPrompt = async ({ gateway }) => {
      bridge.outcomes.push(await gateway.requestApproval({
        sessionId: 'session-1', toolCallId: 'call-6', title: 'bash', label: '终端命令', input: 'orphan',
      }))
    }
    const client = await PhoneClient.connect(url, TOKEN)
    const prompted = client.rpc('session.prompt', { sessionId: 'session-1', text: 'orphan' })
    void prompted.catch(() => {})
    await client.waitEvent('approval.request')
    client.close()
    await waitFor(() => bridge.outcomes.length === 1, 3000, 'no-client cancellation')
    assert.deepEqual(bridge.outcomes, ['cancelled'])
  }, { noClientMs: 60, sweepIntervalMs: 20 })
})

test('HTTP health endpoint answers on the gateway port', async () => {
  await withGateway(async ({ gateway }) => {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/health`)
    const parsed = await response.json()
    assert.equal(parsed.name, 'dsh-remote-mobile')
    assert.equal(parsed.path, '/dsh')
  })
})
