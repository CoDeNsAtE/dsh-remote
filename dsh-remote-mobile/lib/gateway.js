/**
 * Token-authenticated WebSocket gateway for the DSH Remote mobile app.
 *
 * The gateway is host-agnostic: all DeepSeek Harness access goes through the
 * injected `bridge` object (see host-bridge.js), so the protocol layer can be
 * tested against a scripted mock Host.
 *
 * @module dsh-remote-mobile/gateway
 */

import WebSocketPackage from '../vendor/ws/index.js'

import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'

const { WebSocketServer } = WebSocketPackage

import {
  APPROVAL_NO_CLIENT_MS,
  APPROVAL_OPTIONS,
  APPROVAL_TIMEOUT_MS,
  AUTH_TIMEOUT_MS,
  ERROR_CODES,
  MAX_FRAME_BYTES,
  PLUGIN_NAME,
  RpcError,
  VERSION,
  helloPayload,
  isWildcardHost,
  methodNotFound,
  normalizeWsPath,
  safeEqual,
} from './protocol.js'

/**
 * One authenticated WebSocket client plus the sessions it has opened.
 */
class Client {
  /**
   * @param {import('ws').WebSocket} socket underlying socket.
   */
  constructor(socket) {
    this.socket = socket
    this.authenticated = false
    /** @type {Set<string>} sessions this client opened (drives approval interception) */
    this.openedSessions = new Set()
  }
}

export class MobileGateway {
  /**
   * @param {object} options gateway options.
   * @param {object} options.bridge Host bridge implementation.
   * @param {{host: string, port: number, path: string, token: string}} options.config
   * @param {(message: string) => void} [options.log] info logger.
   * @param {(message: string) => void} [options.logError] error logger.
   * @param {number} [options.authTimeoutMs] unauthenticated lifetime.
   * @param {number} [options.approvalTimeoutMs] approval lifetime.
   * @param {number} [options.noClientMs] approval lifetime without clients.
   */
  constructor(options) {
    this.bridge = options.bridge
    this.host = options.config.host
    this.port = options.config.port
    this.path = normalizeWsPath(options.config.path)
    this.token = String(options.config.token ?? '')
    this.log = options.log ?? (() => {})
    this.logError = options.logError ?? (() => {})
    this.authTimeoutMs = options.authTimeoutMs ?? AUTH_TIMEOUT_MS
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS
    this.noClientMs = options.noClientMs ?? APPROVAL_NO_CLIENT_MS
    this.sweepIntervalMs = options.sweepIntervalMs ?? Math.min(15_000, Math.max(1_000, Math.floor(this.noClientMs / 2)))

    /** @type {Set<Client>} */
    this.clients = new Set()
    /** @type {Map<string, object>} */
    this.approvals = new Map()
    /** @type {Map<string, number>} session -> number of clients that opened it */
    this.openedCounts = new Map()
    this.approvalSeq = 0
    this.server = null
    this.wss = null
    this.listening = false
    this.lastError = ''
    this.startedAt = 0
    this.lastClientAt = 0
    this.timer = null
    /** @type {undefined | ((count: number) => void)} */
    this.onClientsChanged = undefined
    this.disposed = false
    this.unsubscribeBridge = undefined
    this._onUpgrade = this.handleUpgrade.bind(this)
  }

  /** Number of authenticated clients. */
  get clientCount() {
    let count = 0
    for (const client of this.clients) if (client.authenticated) count += 1
    return count
  }

  /** Attach the Host event stream and start listening. */
  async start() {
    if (this.listening) return true
    this.disposed = false
    this.lastError = ''
    if (this.bridge?.onEvent !== undefined) {
      this.unsubscribeBridge = this.bridge.onEvent((event, payload) => {
        this.broadcast(event, payload)
      })
    }
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/' || url.pathname === '/health') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        response.end(JSON.stringify({
          name: PLUGIN_NAME,
          version: VERSION,
          port: this.port,
          path: this.path,
          clients: this.clientCount,
        }))
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`DSH Remote: connect over WebSocket at ${this.path}`)
    })
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false })
    server.on('upgrade', this._onUpgrade)
    wss.on('connection', socket => this.handleConnection(socket))
    this.server = server
    this.wss = wss

    const ok = await new Promise(resolve => {
      const onError = error => {
        server.off('listening', onListening)
        this.lastError = describeListenError(error, this.host, this.port)
        this.logError(`[dsh-remote-mobile] ${this.lastError}`)
        this.server = null
        this.wss = null
        try { wss.close() } catch {}
        try { server.close() } catch {}
        resolve(false)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve(true)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(this.port, this.host)
      } catch (error) {
        onError(error)
      }
    })
    if (!ok) return false
    const address = server.address()
    if (address !== null && typeof address === 'object' && typeof address.port === 'number') {
      this.port = address.port
    }
    this.listening = true
    this.startedAt = Date.now()
    this.lastError = ''
    this.timer = setInterval(() => this.sweep(), this.sweepIntervalMs)
    this.timer.unref?.()
    this.log(`[dsh-remote-mobile] listening on ws://${this.host}:${this.port}${this.path}`)
    return true
  }

  /** Stop listening and close every client, cancelling pending approvals. */
  async stop() {
    this.disposed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const requestId of [...this.approvals.keys()]) this.finishApproval(requestId, '', 'shutdown')
    if (this.unsubscribeBridge !== undefined) {
      try { this.unsubscribeBridge() } catch {}
      this.unsubscribeBridge = undefined
    }
    const wss = this.wss
    const server = this.server
    this.wss = null
    this.server = null
    this.listening = false
    for (const client of [...this.clients]) {
      try { client.socket.close(1001, 'gateway shutdown') } catch {}
    }
    this.clients.clear()
    if (wss !== null) {
      try { wss.close() } catch {}
    }
    if (server !== null) {
      try { server.off('upgrade', this._onUpgrade) } catch {}
      await new Promise(resolve => {
        try {
          server.close(() => resolve())
        } catch {
          resolve()
        }
        setTimeout(resolve, 1500).unref?.()
      })
    }
    this.openedCounts.clear()
    this.log('[dsh-remote-mobile] stopped')
  }

  /**
   * Replace the access token and disconnect every existing client.
   * @param {string} token new token (at least 32 chars recommended).
   */
  rotateToken(token) {
    this.token = String(token ?? '')
    for (const client of [...this.clients]) {
      this.sendFrame(client.socket, { type: 'auth.error', message: '访问令牌已更新，请重新连接' })
      try { client.socket.close(4401, 'token rotated') } catch {}
    }
    this.log('[dsh-remote-mobile] access token rotated; all clients disconnected')
    return this.token
  }

  /** LAN + loopback WebSocket URLs for this listener. */
  urls() {
    const port = this.listening ? this.port : this.port
    if (!isWildcardHost(this.host)) {
      return [`ws://${urlHost(this.host)}:${port}${this.path}`]
    }
    const addresses = []
    for (const list of Object.values(networkInterfaces())) {
      for (const entry of list ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        addresses.push(`ws://${entry.address}:${port}${this.path}`)
      }
    }
    const isPrivate = value => /^ws:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value)
    addresses.sort((left, right) => Number(isPrivate(right)) - Number(isPrivate(left)))
    addresses.push(`ws://127.0.0.1:${port}${this.path}`)
    return addresses
  }

  /** Machine-readable snapshot for the settings page. */
  status() {
    return {
      name: PLUGIN_NAME,
      version: VERSION,
      enabled: this.listening,
      listening: this.listening,
      host: this.host,
      port: this.port,
      path: this.path,
      urls: this.listening ? this.urls() : [],
      clientCount: this.clientCount,
      pendingApprovals: this.approvals.size,
      lastError: this.lastError,
      startedAt: this.startedAt,
    }
  }

  /** Broadcast one event frame to every authenticated client. */
  broadcast(event, payload) {
    const frame = { type: 'event', event, ...(payload ?? {}) }
    for (const client of this.clients) {
      if (client.authenticated) this.sendFrame(client.socket, frame)
    }
  }

  /**
   * Ask every connected phone for one tool approval and wait for the first
   * response. Resolves `allowed-once`, `rejected` or `cancelled`.
   * @param {{sessionId: string, toolCallId?: string, title?: string, label?: string, input?: string}} request
   * @returns {Promise<'allowed-once'|'rejected'|'cancelled'>} the approval outcome.
   */
  requestApproval(request) {
    const requestId = `ap-${++this.approvalSeq}`
    const sessionId = String(request.sessionId ?? '')
    const options = request.options ?? APPROVAL_OPTIONS
    const frame = {
      requestId,
      sessionId,
      toolCallId: String(request.toolCallId ?? ''),
      title: String(request.title ?? '工具调用'),
      label: String(request.label ?? '工具调用'),
      input: String(request.input ?? ''),
      options,
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.finishApproval(requestId, '', 'timeout')
      }, this.approvalTimeoutMs)
      timer.unref?.()
      this.approvals.set(requestId, {
        requestId,
        sessionId,
        timer,
        options,
        resolve,
        frame,
      })
      this.broadcast('approval.request', frame)
      this.log(`[dsh-remote-mobile] approval requested: ${frame.label} (${requestId})`)
    })
  }

  /**
   * Resolve one pending approval. An empty/unknown option cancels.
   * @param {string} requestId approval id.
   * @param {string} optionId selected option id, or empty to cancel.
   * @param {string} [reason] resolution reason for the phone.
   * @returns {'allowed-once'|'rejected'|'cancelled'|undefined} outcome when found.
   */
  finishApproval(requestId, optionId, reason = '') {
    const approval = this.approvals.get(requestId)
    if (approval === undefined) return undefined
    clearTimeout(approval.timer)
    this.approvals.delete(requestId)
    let outcome = 'cancelled'
    if (optionId) {
      const selected = approval.options.find(option => option.optionId === optionId)
      if (selected !== undefined) outcome = selected.kind === 'allow_once' ? 'allowed-once' : 'rejected'
    }
    approval.resolve(outcome)
    this.broadcast('approval.resolved', {
      requestId,
      sessionId: approval.sessionId,
      decision: optionId ? 'selected' : 'cancelled',
      optionId: optionId || '',
      reason: reason || '',
    })
    this.log(`[dsh-remote-mobile] approval ${requestId} -> ${optionId || 'cancelled'}${reason ? ` (${reason})` : ''}`)
    return outcome
  }

  /** Cancel every pending approval for one session. */
  cancelApprovalsForSession(sessionId) {
    for (const [requestId, approval] of [...this.approvals]) {
      if (approval.sessionId === sessionId) this.finishApproval(requestId, '', 'cancelled')
    }
  }

  handleUpgrade(request, socket, head) {
    let pathname = ''
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      pathname = ''
    }
    if (pathname !== this.path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(request, socket, head, ws => {
      this.wss.emit('connection', ws, request)
    })
  }

  handleConnection(socket) {
    const client = new Client(socket)
    this.clients.add(client)
    this.lastClientAt = Date.now()

    const authTimer = setTimeout(() => {
      if (client.authenticated) return
      this.sendFrame(socket, { type: 'auth.error', message: '认证超时' })
      try { socket.close(4401, 'auth timeout') } catch {}
    }, this.authTimeoutMs)
    authTimer.unref?.()

    socket.on('message', raw => {
      this.lastClientAt = Date.now()
      let frame
      try {
        frame = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return

      if (!client.authenticated) {
        const token = typeof frame.token === 'string' ? frame.token : ''
        if (frame.type !== 'auth' || !safeEqual(token, this.token) || this.token.length === 0) {
          this.sendFrame(socket, { type: 'auth.error', message: '访问令牌不正确' })
          try { socket.close(4401, 'unauthorized') } catch {}
          return
        }
        client.authenticated = true
        clearTimeout(authTimer)
        this.onClientsChanged?.(this.clientCount)
        this.sendFrame(socket, { type: 'hello', ...this.hello() })
        for (const approval of this.approvals.values()) {
          this.sendFrame(socket, { type: 'event', event: 'approval.request', ...approval.frame })
        }
        this.log(`[dsh-remote-mobile] client connected (${this.clientCount} client(s))`)
        return
      }

      if (frame.type === 'rpc') {
        void this.handleRpc(client, frame)
        return
      }
      if (frame.type === 'ping') {
        this.sendFrame(socket, { type: 'pong', time: Date.now() })
      }
    })

    socket.on('close', () => {
      clearTimeout(authTimer)
      this.clients.delete(client)
      this.lastClientAt = Date.now()
      if (client.authenticated) {
        for (const sessionId of client.openedSessions) this.unwatchSession(sessionId)
        this.onClientsChanged?.(this.clientCount)
        this.log(`[dsh-remote-mobile] client disconnected (${this.clientCount} client(s))`)
      }
    })

    socket.on('error', error => {
      this.logError(`[dsh-remote-mobile] WebSocket error: ${error?.message ?? error}`)
    })
  }

  /** Build the hello/server.info payload from the bridge. */
  hello() {
    const info = this.bridge.info()
    return helloPayload({
      path: this.path,
      workspace: info.workspace,
      defaultCwd: info.defaultCwd,
      online: info.online,
      agent: info.agent,
      capabilities: info.capabilities,
    })
  }

  async handleRpc(client, frame) {
    const id = frame.id
    if (id === undefined || id === null) return
    const method = typeof frame.method === 'string' ? frame.method : ''
    const params = frame.params !== null && typeof frame.params === 'object' ? frame.params : {}
    try {
      const result = await this.dispatch(client, method, params)
      this.sendFrame(client.socket, { type: 'rpc.result', id, result: result ?? {} })
    } catch (error) {
      const code = error instanceof RpcError ? error.code : ERROR_CODES.INTERNAL
      const message = error instanceof Error ? error.message : String(error)
      if (!(error instanceof RpcError)) this.logError(`[dsh-remote-mobile] RPC ${method} failed: ${message}`)
      this.sendFrame(client.socket, { type: 'rpc.error', id, error: { code, message } })
    }
  }

  async dispatch(client, method, params) {
    switch (method) {
      case 'ping':
        return { time: Date.now() }
      case 'server.info':
        return this.hello()
      case 'sessions.list':
        return this.bridge.listSessions()
      case 'session.new': {
        const cwd = typeof params.cwd === 'string' ? params.cwd : ''
        const result = await this.bridge.newSession(cwd)
        if (result?.session?.sessionId) this.watchSession(client, result.session.sessionId)
        return result
      }
      case 'session.open': {
        const sessionId = requireSessionId(params)
        const cwd = typeof params.cwd === 'string' ? params.cwd : ''
        const result = await this.bridge.openSession(sessionId, cwd)
        this.watchSession(client, sessionId)
        return result
      }
      case 'session.prompt': {
        const sessionId = requireSessionId(params)
        const text = typeof params.text === 'string' ? params.text : ''
        if (!text.trim()) throw new RpcError(ERROR_CODES.INVALID_PARAMS, '消息不能为空')
        return this.bridge.prompt(sessionId, text)
      }
      case 'session.cancel': {
        const sessionId = requireSessionId(params)
        this.cancelApprovalsForSession(sessionId)
        return this.bridge.cancel(sessionId)
      }
      case 'session.setConfig': {
        const sessionId = requireSessionId(params)
        const configId = typeof params.configId === 'string' ? params.configId : ''
        const value = typeof params.value === 'string' ? params.value : ''
        if (configId !== 'model' && configId !== 'reasoning_effort') {
          throw new RpcError(ERROR_CODES.INVALID_PARAMS, `未知配置项: ${configId}`)
        }
        return this.bridge.setConfig(sessionId, configId, value)
      }
      case 'approval.respond': {
        const requestId = typeof params.requestId === 'string' ? params.requestId : ''
        const optionId = typeof params.optionId === 'string' ? params.optionId : ''
        if (!requestId) throw new RpcError(ERROR_CODES.INVALID_PARAMS, '缺少参数: requestId')
        const approval = this.approvals.get(requestId)
        if (approval === undefined) throw new RpcError(ERROR_CODES.INTERNAL, '授权请求已失效')
        if (optionId && !approval.options.some(option => option.optionId === optionId)) {
          throw new RpcError(ERROR_CODES.INVALID_PARAMS, `无效的授权选项: ${optionId}`)
        }
        this.finishApproval(requestId, optionId, 'user')
        return { ok: true }
      }
      default:
        throw methodNotFound(method)
    }
  }

  watchSession(client, sessionId) {
    const id = String(sessionId ?? '')
    if (!id) return
    if (client.openedSessions.has(id)) return
    client.openedSessions.add(id)
    const next = (this.openedCounts.get(id) ?? 0) + 1
    this.openedCounts.set(id, next)
    if (next === 1) this.bridge.watchSession?.(id, true)
  }

  unwatchSession(sessionId) {
    const id = String(sessionId ?? '')
    const current = this.openedCounts.get(id) ?? 0
    if (current <= 1) {
      this.openedCounts.delete(id)
      this.bridge.watchSession?.(id, false)
      return
    }
    this.openedCounts.set(id, current - 1)
  }

  sweep() {
    if (this.approvals.size === 0) return
    if (this.clientCount > 0) return
    if (Date.now() - this.lastClientAt < this.noClientMs) return
    for (const requestId of [...this.approvals.keys()]) this.finishApproval(requestId, '', 'no-client')
  }

  sendFrame(socket, frame) {
    if (socket === undefined || socket === null) return
    if (socket.readyState !== 1) return
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      this.logError(`[dsh-remote-mobile] WebSocket send failed: ${error?.message ?? error}`)
    }
  }
}

function requireSessionId(params) {
  const sessionId = params?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new RpcError(ERROR_CODES.INVALID_PARAMS, '缺少参数: sessionId')
  }
  return sessionId
}

function urlHost(host) {
  if (host === '::' || host === '::1') return '[::1]'
  return host
}

function describeListenError(error, host, port) {
  const code = error?.code ?? ''
  if (code === 'EADDRINUSE') return `端口 ${port} 已被占用（${host}:${port}）`
  if (code === 'EACCES') return `没有权限监听 ${host}:${port}`
  if (code === 'EADDRNOTAVAIL') return `监听地址不可用: ${host}`
  return `无法启动网关: ${error?.message ?? error}`
}

export { ERROR_CODES }
