#!/usr/bin/env node
/**
 * Minimal ACP agent used by `selftest.mjs`. It mimics the parts of
 * `dsh --profile acp` that the mobile bridge consumes: sessions, config
 * options, streamed updates, cancellation and one-shot tool approvals.
 */

import { createInterface } from 'node:readline'

const reader = createInterface({ input: process.stdin })
const sessions = new Map()
const pendingClientRequests = new Map()
let nextSession = 0
let nextClientRequest = 1000
let activePrompt = null

const MODEL_VALUES = [
  ['["mock","mock-pro"]', 'Mock Pro'],
  ['["mock","mock-flash"]', 'Mock Flash'],
]

function configOptions(session) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: session?.model ?? MODEL_VALUES[0][0],
      options: [
        {
          group: 'mock',
          name: 'Mock Provider',
          options: MODEL_VALUES.map(([value, name]) => ({ value, name, description: `${name} model` })),
        },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: session?.effort ?? 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
      ],
    },
  ]
}

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function respondError(id, message, code = -32603) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params })
}

function update(sessionId, value) {
  notify('session/update', { sessionId, update: value })
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function askClient(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextClientRequest
    pendingClientRequests.set(id, { resolve, reject })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

function newSession(cwd) {
  const sessionId = `mock-session-${++nextSession}`
  const session = {
    sessionId,
    cwd,
    model: MODEL_VALUES[0][0],
    effort: 'high',
    cancelled: false,
  }
  sessions.set(sessionId, session)
  return session
}

function requireSession(sessionId) {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`unknown session: ${sessionId}`)
  return session
}

async function runTurn(session, text) {
  if (activePrompt) throw new Error('a prompt is already in flight')
  session.cancelled = false
  let cancelResolve
  const cancelSignal = new Promise(resolve => { cancelResolve = resolve })
  activePrompt = {
    session,
    cancel: () => {
      session.cancelled = true
      cancelResolve()
    },
  }
  const pause = ms => Promise.race([delay(ms), cancelSignal])
  const cancelled = () => session.cancelled

  try {
    update(session.sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'mock-thought-1',
      content: { type: 'text', text: `收到「${text.slice(0, 80)}」。先看一下工作区，再运行测试。` },
    })
    await pause(250)
    if (cancelled()) return { stopReason: 'cancelled' }

    update(session.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId: 'mock-call-1',
      title: 'bash',
      kind: 'other',
      status: 'in_progress',
      rawInput: { command: 'npm test', description: 'Run the test suite' },
    })
    await pause(250)

    const outcome = await Promise.race([
      askClient('session/request_permission', {
        sessionId: session.sessionId,
        toolCall: { toolCallId: 'mock-call-1' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }),
      cancelSignal.then(() => ({ outcome: { outcome: 'cancelled' } })),
    ])
    if (cancelled()) return { stopReason: 'cancelled' }

    const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow-once'

    update(session.sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'mock-call-1',
      status: allowed ? 'completed' : 'failed',
      content: [{
        type: 'content',
        content: {
          type: 'text',
          text: allowed ? '12 tests passed in 3.4s' : 'Command rejected by the operator',
        },
      }],
    })
    await pause(250)
    if (cancelled()) return { stopReason: 'cancelled' }

    update(session.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'mock-message-1',
      content: {
        type: 'text',
        text: allowed
          ? '测试已通过，12 个用例全部成功。工作区没有发现构建错误。'
          : '已按你的要求跳过终端命令，没有执行测试。',
      },
    })
    update(session.sessionId, {
      sessionUpdate: 'usage_update',
      used: 1840,
      size: 128000,
    })
    return { stopReason: 'end_turn' }
  } finally {
    if (activePrompt?.session === session) activePrompt = null
  }
}

reader.on('line', async line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }

  if (message.method === undefined && message.id !== undefined) {
    const pending = pendingClientRequests.get(message.id)
    if (!pending) return
    pendingClientRequests.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message))
    else pending.resolve(message.result)
    return
  }

  const { id, method, params = {} } = message
  try {
    switch (method) {
      case 'initialize':
        respond(id, {
          protocolVersion: 1,
          agentInfo: { name: 'mock-acp-agent', version: '0.1.0' },
          agentCapabilities: {
            mcpCapabilities: { http: false, sse: false },
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
          authMethods: [],
        })
        break
      case 'session/new': {
        const session = newSession(params.cwd ?? process.cwd())
        respond(id, { sessionId: session.sessionId, configOptions: configOptions(session) })
        break
      }
      case 'session/list':
        respond(id, {
          sessions: [...sessions.values()].map(session => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            createdAt: Date.now(),
          })),
        })
        break
      case 'session/resume': {
        const session = requireSession(params.sessionId)
        respond(id, { configOptions: configOptions(session) })
        break
      }
      case 'session/close':
        sessions.delete(params.sessionId)
        respond(id, {})
        break
      case 'session/set_config_option': {
        const session = requireSession(params.sessionId)
        if (params.configId === 'model') session.model = String(params.value)
        else if (params.configId === 'reasoning_effort') session.effort = String(params.value)
        respond(id, { configOptions: configOptions(session) })
        break
      }
      case 'session/prompt': {
        const session = requireSession(params.sessionId)
        const text = Array.isArray(params.prompt)
          ? params.prompt.map(block => block.text ?? '').join('')
          : ''
        const result = await runTurn(session, text)
        respond(id, result)
        break
      }
      default:
        if (message.method === 'session/cancel') {
          activePrompt?.cancel()
          break
        }
        if (message.method === '$/cancel_request') break
        if (id !== undefined) respondError(id, `unknown method: ${message.method}`, -32601)
    }
  } catch (error) {
    if (id !== undefined) respondError(id, error.message)
  }
})

process.stdin.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
