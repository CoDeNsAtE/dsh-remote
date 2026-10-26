/**
 * Host adapter tests against a scripted fake Harness context.
 *
 * These exercise the exact Host services the plugin calls
 * (sessionController.list/inspect/create/resolveAgent/selectModel/modelCatalog,
 * agents.get, sessions.get, sessionTitle.get, agentDefaultModel.currentSelection,
 * session events, approval/request waterfall) without booting a real Host.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HostBridge } from '../lib/host-bridge.js'

const CATALOG = {
  default: { provider: 'mock-provider', model: 'mock-flash', reasoningEffort: 'max' },
  routableProviders: ['mock-provider'],
  groups: [
    {
      id: 'mock-provider',
      name: 'Mock',
      models: [
        {
          id: 'mock-flash',
          name: 'Mock Flash',
          description: 'fast',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        },
        { id: 'mock-pro', name: 'Mock Pro', description: 'smart' },
      ],
    },
  ],
  failures: [],
}

class FakeSession {
  constructor(id, { cwd = 'C:\\fake-workspace', createdAt = 1_700_000_000_000 } = {}) {
    this.id = id
    this.header = { version: 4, id, createdAt, cwd, isSeeded: false }
    this.events = []
    this.seq = 0
  }

  snapshotEvents() {
    return this.events.slice()
  }

  requestHeader() {
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      const event = this.events[index]
      if (event.type === 'request/header') return event.data.header
    }
    return undefined
  }

  requestContext() {
    return { contextWindow: 128_000, provider: 'mock-provider', model: 'mock-flash' }
  }
}

class FakeAgent {
  constructor(ctx, session) {
    this.ctx = ctx
    this.id = session.id
    this.session = session
    this.status = 'idle'
    this.followups = []
    this.cancels = []
    this.nextTurnReason = { kind: 'completed' }
    this.turn = 0
  }

  append(type, data) {
    const event = { type, seq: this.session.events.length, time: Date.now(), data }
    this.session.events.push(event)
    this.session.seq = event.seq + 1
    this.ctx.emit('session/event', this.session, event)
    return event
  }

  followup(message) {
    this.followups.push(message)
    queueMicrotask(() => {
      this.status = 'running'
      this.ctx.emit('agent/status', { agent: this, status: 'running' })
      const turn = ++this.turn
      this.append('turn/start', { turn })
      this.ctx.emit('agent/inbox/claimed', { agent: this, message, turn })
      this.append('user/message', message)
      if (this.nextTurnReason.kind === 'error') {
        this.append('turn/end', { turn, reason: this.nextTurnReason })
        this.status = 'idle'
        this.ctx.emit('agent/status', { agent: this, status: 'idle' })
        return
      }
      if (this.nextTurnReason.kind === 'aborted') {
        this.append('turn/end', { turn, reason: this.nextTurnReason })
        this.status = 'idle'
        this.ctx.emit('agent/status', { agent: this, status: 'idle' })
        return
      }
      this.append('assistant/message', {
        turn,
        step: 1,
        message: {
          id: `assistant-${turn}`,
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先想一想' },
            { type: 'text', text: '这是回答' },
          ],
          source: { kind: 'model', provider: 'mock-provider', model: 'mock-flash' },
        },
        stream: [],
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      this.append('turn/end', { turn, reason: this.nextTurnReason })
      this.status = 'idle'
      this.ctx.emit('agent/status', { agent: this, status: 'idle' })
    })
  }

  cancel(cause) {
    this.cancels.push(cause)
    if (this.status === 'running') {
      this.nextTurnReason = { kind: 'aborted', reason: cause }
    }
  }
}

class FakeHarness {
  constructor() {
    this.listeners = new Map()
    this.sessions = new Map()
    this.agents = new Map()
    this.rows = []
    this.selection = { provider: 'mock-provider', model: 'mock-flash', reasoningEffort: 'max' }
    this.catalog = structuredClone(CATALOG)
    this.resumeError = undefined
    this.created = []
    this.selectModelCalls = []
    this.workingDirectory = { defaultDirectory: 'C:\\fake-workspace' }
    this.sessionTitleService = { titles: new Map(), get: session => (this.sessionTitleService.titles.has(session.id) ? { title: this.sessionTitleService.titles.get(session.id) } : undefined) }
    this.sessionProjections = { stateOf: () => undefined }
    this.tokenMeter = { measure: () => ({ totalTokens: 42 }) }
    this.agentDefaultModel = { currentSelection: () => ({ ...this.selection }) }
    this.sessionController = this.createController()
    this.ctx = this.createContext()
  }

  createContext() {
    const services = {
      sessionController: this.sessionController,
      agents: { get: id => this.agents.get(id), list: () => [...this.agents.values()] },
      sessions: { get: id => this.sessions.get(id) },
      sessionTitle: this.sessionTitleService,
      sessionProjections: this.sessionProjections,
      tokenMeter: this.tokenMeter,
      agentDefaultModel: this.agentDefaultModel,
      workingDirectory: this.workingDirectory,
    }
    return {
      get: name => services[name],
      emit: (event, ...args) => this.emit(event, ...args),
      on: (event, callback) => {
        const list = this.listeners.get(event) ?? []
        list.push(callback)
        this.listeners.set(event, list)
        return () => {
          const index = list.indexOf(callback)
          if (index >= 0) list.splice(index, 1)
        }
      },
    }
  }

  emit(event, ...args) {
    for (const callback of this.listeners.get(event) ?? []) callback(...args)
  }

  addLiveSession(id, options = {}) {
    const session = new FakeSession(id, options)
    this.sessions.set(id, session)
    const agent = new FakeAgent(this.ctx, session)
    this.agents.set(id, agent)
    this.rows.unshift({ sessionId: id, updatedAt: Date.now(), running: false, blank: true, cwd: session.header.cwd, agentAvailable: true })
    return { session, agent }
  }

  addColdSession(id, events, options = {}) {
    const session = new FakeSession(id, options)
    session.events = events
    session.seq = events.length
    this.rows.push({ sessionId: id, updatedAt: 1_700_000_200_000, running: false, blank: false, cwd: session.header.cwd, agentAvailable: false })
    return session
  }

  createController() {
    return {
      list: async () => ({ items: this.rows.map(row => ({ ...row })) }),
      inspect: async sessionId => {
        const session = this.sessions.get(sessionId) ?? this.coldSessions?.get(sessionId)
        if (session === undefined) throw new Error(`session "${sessionId}" not found`)
        return { meta: session.header, inheritedEventCount: 0, events: session.events.slice() }
      },
      create: async ({ cwd }) => {
        const id = `session-created-${this.created.length + 1}`
        this.created.push({ id, cwd })
        const { session, agent } = this.addLiveSession(id, { cwd, createdAt: Date.now() })
        agent.nextTurnReason = { kind: 'completed' }
        return { sessionId: id }
      },
      resolveAgent: async sessionId => {
        if (this.resumeError !== undefined) return { error: new Error(this.resumeError) }
        const existing = this.agents.get(sessionId)
        if (existing !== undefined) return { agent: existing }
        const session = this.sessions.get(sessionId) ?? (this.coldSessions?.get(sessionId))
        if (session === undefined) return { error: new Error(`session "${sessionId}" not found`) }
        this.sessions.set(sessionId, session)
        const agent = new FakeAgent(this.ctx, session)
        this.agents.set(sessionId, agent)
        return { agent }
      },
      selectModel: async request => {
        this.selectModelCalls.push(request)
        this.selection = {
          provider: request.provider,
          model: request.model,
          ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
        }
        const session = this.sessions.get(request.sessionId)
        if (session !== undefined) {
          const event = { type: 'model/selection', seq: session.events.length, time: Date.now(), data: { ...this.selection } }
          session.events.push(event)
          session.seq = event.seq + 1
          this.ctx.emit('session/event', session, event)
        }
        return { selected: { ...this.selection } }
      },
      modelCatalog: async () => structuredClone(this.catalog),
    }
  }

  setColdSessions(map) {
    this.coldSessions = map
    for (const [id, session] of map) {
      if (!this.rows.some(row => row.sessionId === id)) {
        this.rows.push({ sessionId: id, updatedAt: 1_700_000_200_000, running: false, blank: false, cwd: session.header.cwd, agentAvailable: false })
      }
    }
  }
}

function makeBridge(harness) {
  const events = []
  const bridge = new HostBridge({
    ctx: harness.ctx,
    config: { workspace: 'C:\\fake-workspace' },
    log: () => {},
    logError: () => {},
  })
  bridge.onEvent((event, payload) => events.push({ event, payload }))
  const approvals = []
  const gateway = {
    clientCount: 1,
    requestApproval: request => {
      return new Promise(resolve => {
        approvals.push({ request, resolve })
      })
    },
    cancelApprovalsForSession: sessionId => {
      for (const entry of approvals) {
        if (entry.request.sessionId === sessionId && !entry.settled) {
          entry.settled = true
          entry.resolve('cancelled')
        }
      }
    },
    broadcast: () => {},
  }
  bridge.setGateway(gateway)
  bridge.attach()
  return { bridge, events, approvals, gateway }
}

test('sessions.list derives phone summary fields for live and cold root sessions', async () => {
  const harness = new FakeHarness()
  const { agent: liveAgent } = harness.addLiveSession('session-live')
  harness.sessionTitleService.titles.set('session-live', '桌面端的会话')
  liveAgent.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '第一行\n第二行' }], source: { kind: 'user' } })
  const coldEvents = [
    { type: 'user/message', seq: 0, time: Date.now(), data: { id: 'u2', role: 'user', content: [{ type: 'text', text: '冷会话问题' }], source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 1, time: Date.now(), data: { turn: 1, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '冷会话回答' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] } },
    { type: 'session/title', seq: 2, time: Date.now(), data: { title: '冷会话标题', messageSeqs: [], source: { kind: 'fallback' } } },
  ]
  const cold = harness.addColdSession('session-cold', coldEvents)
  harness.setColdSessions(new Map([['session-cold', cold]]))
  // Subagent rows are excluded.
  harness.rows.push({ sessionId: 'sub-1', updatedAt: Date.now(), running: false, blank: false, origin: 'subagent', cwd: 'C:\\x' })

  const { bridge } = makeBridge(harness)
  const result = await bridge.listSessions()
  assert.equal(result.online, true)
  assert.deepEqual(result.sessions.map(session => session.sessionId).sort(), ['session-cold', 'session-live'])
  const coldSummary = result.sessions.find(session => session.sessionId === 'session-cold')
  assert.equal(coldSummary.title, '冷会话标题')
  assert.equal(coldSummary.preview, '冷会话回答')
  assert.equal(coldSummary.createdAt, cold.header.createdAt)
  assert.equal(coldSummary.hasTranscript, true)
  assert.equal(coldSummary.running, false)
  const liveSummary = result.sessions.find(session => session.sessionId === 'session-live')
  assert.equal(liveSummary.title, '桌面端的会话')
  assert.equal(liveSummary.hasTranscript, true)
  bridge.dispose()
})

test('newSession creates a real session and returns config options', async () => {
  const harness = new FakeHarness()
  const { bridge } = makeBridge(harness)
  const created = await bridge.newSession('C:\\fake-workspace')
  assert.equal(created.session.title, '新会话')
  assert.equal(harness.created.length, 1)
  assert.equal(harness.created[0].cwd, 'C:\\fake-workspace')
  const model = created.configOptions.find(option => option.id === 'model')
  assert.equal(model.currentValue, JSON.stringify(['mock-provider', 'mock-flash']))
  assert.equal(model.choices.length, 2)
  assert.deepEqual(model.choices.map(choice => choice.name), ['Mock Flash', 'Mock Pro'])
  const reasoning = created.configOptions.find(option => option.id === 'reasoning_effort')
  assert.equal(reasoning.currentValue, 'max')
  assert.ok(reasoning.choices.some(choice => choice.value === ''))
  assert.ok(reasoning.choices.some(choice => choice.value === 'high'))
  bridge.dispose()
})

test('openSession attaches a live session without resuming and reads its transcript', async () => {
  const harness = new FakeHarness()
  const { session, agent } = harness.addLiveSession('session-live')
  agent.append('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })
  agent.append('assistant/message', {
    turn: 1,
    step: 1,
    message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '你好呀' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    stream: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  })
  const { bridge } = makeBridge(harness)
  const opened = await bridge.openSession('session-live', 'C:\\fake-workspace')
  assert.equal(opened.attached, true)
  assert.deepEqual(opened.items.map(item => item.id), ['u:u1', 't:a1', 'a:a1'])
  assert.equal(opened.items[2].text, '你好呀')
  assert.ok(opened.configOptions.some(option => option.id === 'model'))
  bridge.dispose()
})

test('openSession resumes a cold session, and reports detached history on failure', async () => {
  const harness = new FakeHarness()
  const coldEvents = [
    { type: 'user/message', seq: 0, time: Date.now(), data: { id: 'u9', role: 'user', content: [{ type: 'text', text: '冷问题' }], source: { kind: 'user' } } },
  ]
  const cold = harness.addColdSession('session-cold', coldEvents)
  harness.setColdSessions(new Map([['session-cold', cold]]))
  const { bridge } = makeBridge(harness)
  const resumed = await bridge.openSession('session-cold', '')
  assert.equal(resumed.attached, true)
  assert.equal(resumed.items[0].id, 'u:u9')

  harness.resumeError = 'SessionAlreadyOwnedError: session is owned elsewhere'
  // Simulate a foreign owner: the session is no longer attached to this Host.
  harness.sessions.delete('session-cold')
  harness.agents.delete('session-cold')
  const detached = await bridge.openSession('session-cold', '')
  assert.equal(detached.attached, false)
  assert.match(detached.warning, /SessionAlreadyOwnedError/)
  assert.equal(detached.items[0].id, 'u:u9')
  bridge.dispose()
})

test('openSession errors when the session cannot be read at all', async () => {
  const harness = new FakeHarness()
  const { bridge } = makeBridge(harness)
  await assert.rejects(() => bridge.openSession('missing-session', ''), /会话不存在或无法读取/)
  bridge.dispose()
})

test('prompt admits a real user message, streams items, and resolves at turn end', async () => {
  const harness = new FakeHarness()
  const { agent } = harness.addLiveSession('session-live')
  const { bridge, events } = makeBridge(harness)
  await bridge.openSession('session-live', '')
  const result = await bridge.prompt('session-live', '帮我看看')
  assert.deepEqual(result, { stopReason: 'end_turn' })
  assert.equal(agent.followups.length, 1)
  const message = agent.followups[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'user')
  assert.equal(message.content[0].text, '帮我看看')
  const itemEvents = events.filter(entry => entry.event === 'item.upsert').map(entry => entry.payload.item)
  assert.ok(itemEvents.some(item => item.id === `u:${message.id}`))
  assert.ok(itemEvents.some(item => item.id === 't:assistant-1'))
  assert.ok(itemEvents.some(item => item.id === 'a:assistant-1'))
  const statuses = events.filter(entry => entry.event === 'turn.status').map(entry => entry.payload.status)
  assert.deepEqual(statuses, ['running', 'idle'])
  bridge.dispose()
})

test('prompt failure rejects the RPC and appends a notice item', async () => {
  const harness = new FakeHarness()
  const { agent } = harness.addLiveSession('session-live')
  agent.nextTurnReason = { kind: 'error', error: { message: '模型余额不足', code: 'INSUFFICIENT_BALANCE' } }
  const { bridge, events } = makeBridge(harness)
  await bridge.openSession('session-live', '')
  await assert.rejects(() => bridge.prompt('session-live', '试试'), /模型余额不足/)
  const notices = events.filter(entry => entry.event === 'item.upsert').map(entry => entry.payload.item).filter(item => item.kind === 'notice')
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /执行失败/)
  bridge.dispose()
})

test('cancelled turns resolve with the cancelled stop reason', async () => {
  const harness = new FakeHarness()
  harness.addLiveSession('session-live')
  const { bridge } = makeBridge(harness)
  await bridge.openSession('session-live', '')
  const pending = bridge.prompt('session-live', '长时间任务')
  await bridge.cancel('session-live')
  const result = await pending
  assert.equal(result.stopReason, 'cancelled')
  bridge.dispose()
})

test('setConfig switches model and reasoning through the Host selection seam', async () => {
  const harness = new FakeHarness()
  harness.addLiveSession('session-live')
  const { bridge } = makeBridge(harness)
  await bridge.openSession('session-live', '')
  const changed = await bridge.setConfig('session-live', 'reasoning_effort', 'high')
  assert.equal(harness.selectModelCalls[0].reasoningEffort, 'high')
  const reasoning = changed.configOptions.find(option => option.id === 'reasoning_effort')
  assert.equal(reasoning.currentValue, 'high')
  const modelChanged = await bridge.setConfig('session-live', 'model', JSON.stringify(['mock-provider', 'mock-pro']))
  assert.equal(harness.selectModelCalls[1].model, 'mock-pro')
  const model = modelChanged.configOptions.find(option => option.id === 'model')
  assert.equal(model.currentValue, JSON.stringify(['mock-provider', 'mock-pro']))
  await assert.rejects(() => bridge.setConfig('session-live', 'model', 'not-json'), /JSON/)
  bridge.dispose()
})

test('approval interception only covers phone-opened sessions', async () => {
  const harness = new FakeHarness()
  const { session } = harness.addLiveSession('session-live')
  const { bridge, approvals } = makeBridge(harness)
  let nextCalls = 0
  const next = () => {
    nextCalls += 1
    return Promise.resolve('unavailable')
  }
  const request = { agent: harness.agents.get('session-live'), toolName: 'bash', callId: 'call-1' }
  const untracked = await bridge.handleApprovalRequest(request, next)
  assert.equal(untracked, 'unavailable')
  assert.equal(nextCalls, 1)

  bridge.watchSession('session-live', true)
  bridge.ensureStore('session-live').ingest({
    type: 'tool/call',
    seq: 0,
    time: Date.now(),
    data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' },
  })
  const pending = bridge.handleApprovalRequest(request, next)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(approvals.length, 1)
  assert.equal(approvals[0].request.sessionId, 'session-live')
  assert.equal(approvals[0].request.label, '终端命令')
  assert.match(approvals[0].request.input, /npm test/)
  approvals[0].resolve('allowed-once')
  assert.equal(await pending, 'allowed-once')
  assert.equal(nextCalls, 1)
  assert.equal(session.header.id, 'session-live')
  bridge.dispose()
})

test('approval falls through when no phone client is connected', async () => {
  const harness = new FakeHarness()
  harness.addLiveSession('session-live')
  const { bridge, gateway } = makeBridge(harness)
  bridge.watchSession('session-live', true)
  gateway.clientCount = 0
  let nextCalls = 0
  const outcome = await bridge.handleApprovalRequest(
    { agent: harness.agents.get('session-live'), toolName: 'bash' },
    () => {
      nextCalls += 1
      return Promise.resolve('unavailable')
    },
  )
  assert.equal(outcome, 'unavailable')
  assert.equal(nextCalls, 1)
  bridge.dispose()
})
