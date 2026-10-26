/**
 * Test helpers: a scripted Host bridge, an in-process gateway, and a phone
 * protocol client built on the same vendored ws package.
 */
import { createServer } from 'node:http'

import WebSocketPackage from '../vendor/ws/index.js'
import { MobileGateway } from '../lib/gateway.js'

const WebSocket = WebSocketPackage
export const TOKEN = 'test-token-0123456789abcdefghijklmnop'

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

export function configOptions() {
  return [
    {
      id: 'model',
      name: '模型',
      category: 'model',
      type: 'select',
      currentValue: JSON.stringify(['mock-provider', 'mock-flash']),
      choices: [
        { value: JSON.stringify(['mock-provider', 'mock-flash']), name: 'Mock Flash', group: 'Mock', description: '' },
        { value: JSON.stringify(['mock-provider', 'mock-pro']), name: 'Mock Pro', group: 'Mock', description: '' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: '推理强度',
      category: 'thought_level',
      type: 'select',
      currentValue: '',
      choices: [
        { value: '', name: '默认', group: '', description: '' },
        { value: 'high', name: 'High', group: '', description: '' },
      ],
    },
  ]
}

export function sessionSummary(sessionId, overrides = {}) {
  return {
    sessionId,
    cwd: 'C:\\mock-workspace',
    title: 'Mock 会话',
    preview: '你好',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    running: false,
    hasTranscript: true,
    ...overrides,
  }
}

/** Scripted Host side; records every call the gateway makes. */
export class MockBridge {
  constructor() {
    this.events = undefined
    this.calls = []
    this.watched = new Map()
    this.sessions = [sessionSummary('session-1')]
    this.history = new Map()
    this.prompts = []
    this.configChanges = []
    this.cancelled = []
    this.outcomes = []
    this.openAttached = true
    this.openWarning = ''
    this.stopReason = 'end_turn'
    this.onPrompt = undefined
    this.gateway = undefined
    this.inflightSessions = new Set()
  }

  setGateway(gateway) {
    this.gateway = gateway
  }

  info() {
    return {
      workspace: 'C:\\mock-workspace',
      defaultCwd: 'C:\\mock-workspace',
      online: true,
      agent: { name: 'deepseek-harness', version: '0.2.1-rc.3' },
      capabilities: {},
    }
  }

  onEvent(listener) {
    this.events = listener
    return () => {
      this.events = undefined
    }
  }

  emit(event, payload) {
    this.events?.(event, payload)
  }

  watchSession(sessionId, watching) {
    this.calls.push(['watchSession', sessionId, watching])
    this.watched.set(sessionId, watching)
  }

  async listSessions() {
    this.calls.push(['listSessions'])
    return { sessions: this.sessions.map(session => ({ ...session })), online: true, warning: '' }
  }

  async newSession(cwd) {
    this.calls.push(['newSession', cwd])
    const session = sessionSummary('session-new', {
      cwd: cwd || 'C:\\mock-workspace',
      title: '新会话',
      preview: '',
      hasTranscript: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    this.sessions.unshift(session)
    return { session, configOptions: configOptions() }
  }

  async openSession(sessionId, cwd) {
    this.calls.push(['openSession', sessionId, cwd])
    const existing = this.sessions.find(session => session.sessionId === sessionId)
    const session = existing ?? sessionSummary(sessionId, { cwd: cwd || 'C:\\mock-workspace' })
    return {
      session,
      items: this.history.get(sessionId) ?? [],
      configOptions: configOptions(),
      attached: this.openAttached,
      warning: this.openWarning,
    }
  }

  async prompt(sessionId, text) {
    this.calls.push(['prompt', sessionId, text])
    if (this.inflightSessions?.has(sessionId)) {
      const error = new Error('该会话正在执行，请先取消或等待完成')
      error.code = -32603
      throw error
    }
    this.inflightSessions ??= new Set()
    this.inflightSessions.add(sessionId)
    try {
      this.prompts.push({ sessionId, text })
      this.emit('turn.status', { sessionId, status: 'running', stopReason: '' })
      this.emit('item.upsert', {
        sessionId,
        item: { id: 'u:1', kind: 'user', text, time: Date.now(), title: '', label: '', status: '', toolCallId: '', input: '', result: '', collapsed: false },
      })
      if (this.onPrompt !== undefined) await this.onPrompt(this, sessionId, text)
      this.emit('turn.status', { sessionId, status: 'idle', stopReason: this.stopReason })
      return { stopReason: this.stopReason }
    } finally {
      this.inflightSessions.delete(sessionId)
    }
  }

  async cancel(sessionId) {
    this.calls.push(['cancel', sessionId])
    this.cancelled.push(sessionId)
    return {}
  }

  async setConfig(sessionId, configId, value) {
    this.calls.push(['setConfig', sessionId, configId, value])
    this.configChanges.push({ sessionId, configId, value })
    const options = configOptions()
    const target = options.find(option => option.id === configId)
    if (target !== undefined) {
      target.currentValue = value
      if (configId === 'model') {
        const [provider, model] = JSON.parse(value)
        target.choices = target.choices.map(choice => ({ ...choice, name: `${provider}/${model}` }))
      }
    }
    this.emit('config.updated', { sessionId, configOptions: options })
    return { configOptions: options }
  }
}

/**
 * Start an in-process gateway on a loopback random port.
 * @returns {Promise<{gateway: MobileGateway, url: string, close: () => Promise<void>}>}
 */
export async function startGateway(bridge, options = {}) {
  const gateway = new MobileGateway({
    bridge,
    config: { host: '127.0.0.1', port: 0, path: '/dsh', token: TOKEN, ...(options.config ?? {}) },
    log: () => {},
    logError: () => {},
    ...(options.gateway ?? {}),
  })
  bridge.setGateway(gateway)
  const started = await gateway.start()
  if (!started) throw new Error(`gateway failed to start: ${gateway.lastError}`)
  const url = `ws://127.0.0.1:${gateway.port}${gateway.path}`
  return {
    gateway,
    url,
    close: async () => {
      await gateway.stop()
    },
  }
}

/** Phone protocol client. */
export class PhoneClient {
  constructor() {
    this.frames = []
    this.waiters = []
    this.pending = new Map()
    this.sequence = 0
    this.closed = undefined
    this.socket = undefined
  }

  /**
   * @param {string} url websocket url.
   * @param {string} token access token.
   * @param {{timeoutMs?: number}} [options]
   * @returns {Promise<PhoneClient>}
   */
  static async connect(url, token, options = {}) {
    const client = new PhoneClient()
    await client.connectWithAuth(url, token, options.timeoutMs ?? 3000)
    return client
  }

  /** Open the socket and send one auth frame, resolving on hello. */
  connectWithAuth(url, token, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      this.openSocket(url, timeoutMs).then(() => {
        this.socket.send(JSON.stringify({ type: 'auth', token }))
        this.waitFrame(frame => frame.type === 'hello', timeoutMs).then(() => resolve(this), reject)
      }, reject)
    })
  }

  /** Open the socket, send a wrong token, and resolve once auth.error arrives. */
  static async connectExpectAuthError(url, token, timeoutMs = 3000) {
    const client = new PhoneClient()
    await client.openSocket(url, timeoutMs)
    client.socket.send(JSON.stringify({ type: 'auth', token }))
    await client.waitFrame(frame => frame.type === 'auth.error', timeoutMs)
    return client
  }

  /** Open the socket without authenticating. */
  openSocket(url, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      this.socket = socket
      const timer = setTimeout(() => reject(new Error('connect timeout')), timeoutMs)
      socket.on('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.on('message', raw => {
        let frame
        try {
          frame = JSON.parse(raw.toString())
        } catch {
          return
        }
        this.frames.push(frame)
        if (frame.type === 'auth.error') this.authError = frame.message
        if (frame.type === 'rpc.result') {
          const pending = this.pending.get(frame.id)
          if (pending !== undefined) {
            this.pending.delete(frame.id)
            pending.resolve(frame.result)
          }
        } else if (frame.type === 'rpc.error') {
          const pending = this.pending.get(frame.id)
          if (pending !== undefined) {
            this.pending.delete(frame.id)
            pending.reject(Object.assign(new Error(frame.error?.message ?? 'rpc failed'), { code: frame.error?.code }))
          }
        }
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(frame)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1)
            waiter.resolve(frame)
          }
        }
      })
      socket.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() }
        clearTimeout(timer)
      })
      socket.on('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  rpc(method, params = {}, timeoutMs = 5000) {
    const id = `rpc-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`rpc timeout: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ type: 'rpc', id, method, params }))
    })
  }

  /** Send one raw frame and wait for its RPC error (for negative tests). */
  async rpcError(method, params = {}, timeoutMs = 5000) {
    try {
      const result = await this.rpc(method, params, timeoutMs)
      return { code: undefined, result }
    } catch (error) {
      return { code: error.code, message: error.message }
    }
  }

  ping() {
    this.socket.send(JSON.stringify({ type: 'ping' }))
    return this.waitFrame(frame => frame.type === 'pong')
  }

  waitFrame(predicate, timeoutMs = 5000) {
    for (const frame of this.frames) {
      if (predicate(frame)) return Promise.resolve(frame)
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve }
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('timed out waiting for frame'))
      }, timeoutMs)
      waiter.resolve = frame => {
        clearTimeout(timer)
        resolve(frame)
      }
      this.waiters.push(waiter)
    })
  }

  waitEvent(event, predicate = () => true, timeoutMs = 5000) {
    return this.waitFrame(frame => frame.type === 'event' && frame.event === event && predicate(frame), timeoutMs)
  }

  events(event) {
    return this.frames.filter(frame => frame.type === 'event' && frame.event === event)
  }

  close() {
    try {
      this.socket?.close()
    } catch {}
  }
}

export { createServer }
