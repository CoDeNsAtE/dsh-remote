/**
 * DeepSeek Harness host adapter for the mobile gateway.
 *
 * Everything the phone sees is derived from the Host's own live Sessions and
 * durable Session logs: sessions are listed through the Host session
 * controller, prompts are admitted into the real live Agent, model changes go
 * through the Host model-selection seam, and tool approvals are forwarded
 * through the Host `approval/request` waterfall only for sessions a phone has
 * opened.
 *
 * Internal signatures this file relies on were verified against the shipped
 * DSH runtime 0.2.1-rc.3 (see docs/HOST-API.md).
 *
 * @module dsh-remote-mobile/host-bridge
 */

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

import { SessionItemStore, formatToolInput, truncate } from './item-mapper.js'
import {
  APPROVAL_OPTIONS,
  MAX_OPEN_ITEMS,
  MAX_SESSIONS,
  RpcError,
  ERROR_CODES,
  previewText,
  titleFromPrompt,
  toolLabel,
} from './protocol.js'

/** Live-session cache of one derived transcript. */
const STORE_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'session/title',
  'model/selection',
  'request/header',
])

/** Events that can change the phone's session row. */
const SUMMARY_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'session/title',
  'turn/start',
  'turn/end',
  'model/selection',
])

function errorMessage(error) {
  if (error === null || error === undefined) return '未知错误'
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error.message !== undefined) return String(error.message)
  if (error.code !== undefined) return String(error.code)
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isSubagentSession(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * Channel between the gateway and the running Harness.
 */
export class HostBridge {
  /**
   * @param {object} options bridge options.
   * @param {import('@deepseek-ai/cordis').Context} options.ctx plugin context.
   * @param {object} options.config resolved plugin config.
   * @param {(message: string) => void} [options.log]
   * @param {(message: string) => void} [options.logError]
   */
  constructor(options) {
    this.ctx = options.ctx
    this.config = options.config
    this.log = options.log ?? (() => {})
    this.logError = options.logError ?? (() => {})
    /** @type {Map<string, SessionItemStore>} */
    this.stores = new Map()
    /** @type {Set<string>} sessions at least one phone has opened */
    this.watched = new Set()
    /** @type {Map<string, Record<string, any>>} */
    this.lastSummaries = new Map()
    /** @type {Map<string, {updatedAt: number, meta: Record<string, any>}>} */
    this.metaCache = new Map()
    /** @type {Map<string, {messageId: string, turn: number|undefined, settled: boolean, resolve: Function, reject: Function, error?: Error}>} */
    this.inflight = new Map()
    /** @type {string[]} */
    this.lastErrors = []
    this.gateway = undefined
    this.catalog = undefined
    this.catalogAt = 0
    this.listeners = []
    this.harnessDisposers = []
    /** @type {Map<string, ReturnType<typeof setTimeout>>} */
    this.summaryTimers = new Map()
    /** @type {Map<string, 'running'|'idle'>} */
    this.lastTurnStatus = new Map()
    /** @type {Set<string>} cancel requests that raced prompt admission */
    this.pendingCancel = new Set()
    this.defaultCwd = this.resolveDefaultCwd()
    this.hostOnline = true
    this.disposed = false
    this.debugCounters = {
      attached: false,
      sessionEvents: 0,
      byType: {},
      claimed: 0,
      statuses: 0,
      settles: 0,
      turnEndsWithoutInflight: 0,
    }
  }

  /** Diagnostics exposed through the settings state snapshot. */
  debugSnapshot() {
    return {
      attached: this.debugCounters.attached,
      sessionEvents: this.debugCounters.sessionEvents,
      byType: { ...this.debugCounters.byType },
      claimed: this.debugCounters.claimed,
      statuses: this.debugCounters.statuses,
      settles: this.debugCounters.settles,
      turnEndsWithoutInflight: this.debugCounters.turnEndsWithoutInflight,
      inflight: [...this.inflight.keys()],
      stores: [...this.stores.entries()].map(([id, store]) => ({ id, items: store.items.length })),
      watched: [...this.watched],
      hostOnline: this.hostOnline,
    }
  }

  /** @param {import('./gateway.js').MobileGateway} gateway */
  setGateway(gateway) {
    this.gateway = gateway
  }

  /** Live Agent lookup through the Host registry. */
  agentOf(sessionId) {
    return this.ctx.get('agents')?.get?.(sessionId)
  }

  /** Live Session lookup through the Host store. */
  sessionOf(sessionId) {
    return this.ctx.get('sessions')?.get?.(sessionId)
  }

  /** Current local default workspace for new sessions. */
  resolveDefaultCwd() {
    const configured = String(this.config.workspace ?? '').trim()
    if (configured) return configured
    try {
      const workspace = this.ctx.get('workspaceRegistry')?.list?.()[0]
      if (workspace?.path) return workspace.path
    } catch {}
    const workingDirectory = this.ctx.get('workingDirectory')
    if (workingDirectory?.defaultDirectory) return workingDirectory.defaultDirectory
    return process.cwd()
  }

  liveness() {
    return {
      online: this.ctx.get('sessionController') !== undefined && this.ctx.get('agents') !== undefined,
      warning: this.lastErrors.at(-1) ?? '',
    }
  }

  info() {
    const live = this.liveness()
    return {
      workspace: this.defaultCwd,
      defaultCwd: this.defaultCwd,
      online: live.online,
      agent: {
        name: 'deepseek-harness',
        version: process.env.DSH_VERSION ?? '',
      },
      capabilities: {
        websocket: true,
        sessions: true,
        approvals: true,
        models: true,
        streaming: true,
      },
    }
  }

  /** Subscribe the gateway to browser-facing events. */
  onEvent(listener) {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index >= 0) this.listeners.splice(index, 1)
    }
  }

  emitEvent(event, payload) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event, payload)
      } catch (error) {
        this.logError(`[dsh-remote-mobile] event listener failed: ${errorMessage(error)}`)
      }
    }
  }

  /** Track and broadcast Host availability transitions. */
  noteHostOnline(online, message = '') {
    if (this.hostOnline === online) return
    this.hostOnline = online
    this.emitEvent('bridge.status', { online, message })
  }

  /** Expose the session watcher count so approval interception stays correct. */
  watchSession(sessionId, watching) {
    if (watching) {
      this.watched.add(sessionId)
    } else {
      this.watched.delete(sessionId)
    }
  }

  /** Wire global Harness listeners; they live until the plugin fiber disposes. */
  attach() {
    const disposers = [
      this.ctx.on('session/event', (session, event) => this.handleSessionEvent(session, event), { global: true }),
      this.ctx.on('agent/inbox/claimed', payload => this.handleInboxClaimed(payload), { global: true }),
      this.ctx.on('agent/status', payload => this.handleAgentStatus(payload), { global: true }),
      this.ctx.on('agent/error', payload => this.handleAgentError(payload), { global: true }),
      this.ctx.on('agent/disposed', payload => this.handleAgentDisposed(payload), { global: true }),
      this.ctx.on('llm/adapters-updated', () => this.invalidateCatalog(), { global: true }),
      this.ctx.on('approval/request', (request, next) => this.handleApprovalRequest(request, next), { global: true, prepend: true }),
    ]
    this.harnessDisposers = disposers
    this.debugCounters.attached = true
    this.log('[dsh-remote-mobile] host bridge attached')
  }

  dispose() {
    this.disposed = true
    for (const timer of this.summaryTimers.values()) {
      try {
        clearTimeout(timer)
      } catch {}
    }
    this.summaryTimers.clear()
    this.lastTurnStatus.clear()
    for (const dispose of this.harnessDisposers ?? []) {
      try {
        dispose()
      } catch {}
    }
    this.harnessDisposers = []
    for (const [, record] of [...this.inflight]) {
      if (!record.settled) {
        record.settled = true
        record.reject(new Error('网关已停用'))
      }
    }
    this.inflight.clear()
    this.stores.clear()
    this.watched.clear()
    this.lastSummaries.clear()
    this.metaCache.clear()
    this.listeners = []
  }

  // ---------------------------------------------------------------------
  // Session list
  // ---------------------------------------------------------------------

  /**
   * List root sessions, deriving the phone summary fields the Host API omits.
   * @returns {Promise<{sessions: Array<Record<string, any>>, online: boolean, warning: string}>}
   */
  async listSessions() {
    const controller = this.requireController()
    let listed
    try {
      listed = await controller.list({})
    } catch (error) {
      const message = errorMessage(error)
      this.lastErrors.push(`sessions.list: ${message}`)
      this.noteHostOnline(false, `读取会话列表失败: ${message}`)
      const cached = [...this.lastSummaries.values()]
      return {
        sessions: cached.filter(summary => summary.sessionId).sort((left, right) => right.updatedAt - left.updatedAt),
        online: false,
        warning: `读取会话列表失败: ${message}`,
      }
    }
    const rows = Array.isArray(listed) ? listed : listed?.items
    if (!Array.isArray(rows)) {
      throw this.wrapInternal('读取会话列表失败', new Error('Host sessionController.list 返回了意外结构'))
    }
    this.noteHostOnline(true)
    const roots = rows
      .filter(row => row.origin !== 'subagent')
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
      .slice(0, MAX_SESSIONS)
    this.noteHostOnline(true)
    const summaries = []
    const warnings = []
    for (const row of roots) {
      try {
        summaries.push(await this.describeRow(row))
      } catch (error) {
        warnings.push(`${row.sessionId}: ${errorMessage(error)}`)
      }
    }
    summaries.sort((left, right) => right.updatedAt - left.updatedAt)
    return {
      sessions: summaries,
      online: true,
      warning: warnings.length > 0 ? `部分会话无法读取: ${warnings.slice(0, 3).join('; ')}` : '',
    }
  }

  async describeRow(row) {
    const sessionId = String(row.sessionId)
    const cached = this.metaCache.get(sessionId)
    if (cached !== undefined && cached.updatedAt === row.updatedAt) {
      return this.summaryFromMeta(sessionId, cached.meta, row)
    }
    const live = this.sessionOf(sessionId)
    let meta
    if (live !== undefined && !isSubagentSession(live)) {
      meta = this.describeLive(live)
    } else {
      const inspected = await this.inspectSession(sessionId)
      meta = this.describeEvents(inspected.header, inspected.events)
    }
    this.metaCache.set(sessionId, { updatedAt: row.updatedAt, meta })
    return this.summaryFromMeta(sessionId, meta, row)
  }

  describeLive(session) {
    const title = this.titleOf(session)
    const store = this.stores.get(session.id)
    let preview = store?.preview ?? ''
    let hasTranscript = store?.hasTranscript ?? false
    if (store === undefined) {
      const tail = this.tailText(session)
      preview = tail.preview || preview
      hasTranscript = tail.hasTranscript || hasTranscript
    }
    return {
      title,
      preview,
      createdAt: Number(session.header?.createdAt ?? 0),
      cwd: String(session.header?.cwd ?? ''),
      hasTranscript,
    }
  }

  describeEvents(header, events) {
    let title = ''
    let firstUser = ''
    let lastText = ''
    let hasTranscript = false
    for (const event of events ?? []) {
      const data = event?.data ?? {}
      if (event.type === 'session/title') {
        const value = String(data.title ?? '').trim()
        if (value) title = value
      } else if (event.type === 'user/message') {
        if (data.source?.kind !== 'user') continue
        const text = messageText(data).trim()
        if (!text) continue
        if (!firstUser) firstUser = text
        lastText = text
        hasTranscript = true
      } else if (event.type === 'assistant/message') {
        const text = messageText(data.message).trim()
        if (text) {
          lastText = text
          hasTranscript = true
        }
      } else if (event.type === 'tool/call' || event.type === 'tool/result') {
        hasTranscript = true
      }
    }
    return {
      title: title || previewText(firstUser.split('\n')[0] ?? '', 48),
      preview: previewText(lastText),
      createdAt: Number(header?.createdAt ?? 0),
      cwd: String(header?.cwd ?? ''),
      hasTranscript,
    }
  }

  titleOf(session) {
    const titleService = this.ctx.get('sessionTitle')
    try {
      const snapshot = titleService?.get?.(session)
      if (snapshot?.title) return String(snapshot.title)
    } catch {}
    const store = this.stores.get(session.id)
    if (store?.title) return store.title
    const cached = this.metaCache.get(session.id)
    return cached?.meta?.title ?? ''
  }

  tailText(session) {
    // Walk the tail of the durable log for a cheap preview without building items.
    let preview = ''
    let hasTranscript = false
    try {
      const events = session.snapshotEvents()
      for (let index = events.length - 1; index >= 0 && index >= events.length - 400; index -= 1) {
        const event = events[index]
        if (event.type === 'assistant/message') {
          hasTranscript = true
          const text = messageText(event.data?.message).trim()
          if (text) {
            preview = text
            break
          }
          continue
        }
        if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
          hasTranscript = true
          const text = messageText(event.data).trim()
          if (text) {
            preview = text
            break
          }
          continue
        }
        if (event.type === 'tool/call' || event.type === 'tool/result') hasTranscript = true
      }
    } catch {}
    return { preview: previewText(preview), hasTranscript }
  }

  summaryFromMeta(sessionId, meta, row) {
    const live = this.sessionOf(sessionId)
    const agent = this.agentOf(sessionId)
    const runtimeRunning = agent?.status === 'running'
    const title = meta.title || basename(meta.cwd || '') || `会话 ${String(sessionId).slice(0, 6)}`
    const summary = {
      sessionId,
      cwd: String(meta.cwd ?? row.cwd ?? ''),
      title,
      preview: meta.preview || '',
      createdAt: Number(meta.createdAt ?? 0),
      updatedAt: Number(row.updatedAt ?? 0) || Date.now(),
      running: row.running === true || runtimeRunning,
      hasTranscript: meta.hasTranscript === true,
    }
    this.lastSummaries.set(sessionId, summary)
    return summary
  }

  /** Refresh one summary (synchronously for live sessions) after a new event. */
  refreshSummary(sessionId) {
    const previous = this.lastSummaries.get(sessionId)
    const live = this.sessionOf(sessionId)
    const agent = this.agentOf(sessionId)
    const store = this.stores.get(sessionId)
    const title = live !== undefined ? this.titleOf(live) : (store?.title || previous?.title || '')
    const cwd = String(live?.header?.cwd ?? previous?.cwd ?? '')
    const summary = {
      sessionId,
      cwd,
      title: title || basename(cwd || '') || `会话 ${String(sessionId).slice(0, 6)}`,
      preview: store?.preview || previous?.preview || '',
      createdAt: Number(live?.header?.createdAt ?? previous?.createdAt ?? 0),
      updatedAt: Date.now(),
      running: agent?.status === 'running' || this.inflight.has(sessionId),
      hasTranscript: store?.hasTranscript ?? previous?.hasTranscript ?? false,
    }
    this.lastSummaries.set(sessionId, summary)
    const meta = this.metaCache.get(sessionId)
    if (meta !== undefined) {
      this.metaCache.set(sessionId, {
        updatedAt: summary.updatedAt,
        meta: {
          ...meta.meta,
          title: summary.title,
          preview: summary.preview,
          createdAt: summary.createdAt,
          cwd,
          hasTranscript: summary.hasTranscript,
        },
      })
    }
    return summary
  }

  broadcastSessionUpdated(sessionId) {
    const summary = this.refreshSummary(sessionId)
    this.emitEvent('session.updated', { session: summary })
    return summary
  }

  /** Throttled variant used by the high-frequency durable event feed. */
  broadcastSessionUpdatedSoon(sessionId) {
    const pending = this.summaryTimers.get(sessionId)
    if (pending !== undefined) return
    const timer = setTimeout(() => {
      this.summaryTimers.delete(sessionId)
      if (this.disposed) return
      try {
        this.broadcastSessionUpdated(sessionId)
      } catch {}
    }, 250)
    timer.unref?.()
    this.summaryTimers.set(sessionId, timer)
  }

  // ---------------------------------------------------------------------
  // New / open
  // ---------------------------------------------------------------------

  /**
   * Create a real Harness session through the Host session controller, which
   * composes the user's normal Agent preset (plugins, skills, MCP, tools).
   * @param {string} cwd requested working directory (absolute) or empty.
   * @returns {Promise<{session: Record<string, any>, configOptions: Array<Record<string, any>>}>}
   */
  async newSession(cwd) {
    const controller = this.requireController()
    const directory = this.normalizeCwd(cwd)
    let created
    try {
      created = await controller.create({ cwd: directory })
    } catch (error) {
      throw this.wrapInternal('新建会话失败', error)
    }
    const sessionId = String(created.sessionId)
    const agent = await this.requireAgent(sessionId)
    const session = agent.session ?? this.sessionOf(sessionId)
    if (session === undefined) throw this.wrapInternal('新建会话失败', new Error('会话未就绪'))
    const store = this.ensureStore(sessionId)
    store.reset(session.snapshotEvents(), {
      createdAt: session.header?.createdAt,
      cwd: session.header?.cwd ?? directory,
      title: '新会话',
    })
    const selection = this.defaultSelection()
    const configOptions = await this.configOptionsFor(sessionId, selection)
    const summary = {
      sessionId,
      cwd: String(session.header?.cwd ?? directory),
      title: '新会话',
      preview: '',
      createdAt: Number(session.header?.createdAt ?? Date.now()),
      updatedAt: Date.now(),
      running: false,
      hasTranscript: false,
    }
    this.lastSummaries.set(sessionId, summary)
    this.watched.add(sessionId)
    this.broadcastSessionUpdated(sessionId)
    return { session: summary, configOptions }
  }

  /**
   * Attach to a live session or resume a cold one without running the model.
   * @param {string} sessionId session identity.
   * @param {string} cwd optional working directory from the phone.
   * @returns {Promise<{session: Record<string, any>, items: Array<Record<string, any>>, configOptions: Array<Record<string, any>>, attached: boolean, warning: string}>}
   */
  async openSession(sessionId, cwd) {
    let live = this.sessionOf(sessionId)
    let attached = live !== undefined
    let warning = ''
    if (live === undefined) {
      const found = await this.tryResumeAgent(sessionId)
      if (found.error !== undefined) {
        warning = found.error
      } else {
        live = this.sessionOf(sessionId) ?? found.agent?.session
        attached = live !== undefined
      }
    }
    let header
    let events
    if (live !== undefined) {
      header = live.header
      events = live.snapshotEvents()
    } else {
      const inspected = await this.inspectSession(sessionId)
      header = inspected.header
      events = inspected.events
    }
    const store = this.ensureStore(sessionId)
    store.reset(events, {
      createdAt: header?.createdAt,
      cwd: header?.cwd ?? (cwd || this.defaultCwd),
    })
    const selection = store.currentSelection() ?? this.selectionOfAgent(sessionId) ?? this.defaultSelection()
    const configOptions = await this.configOptionsFor(sessionId, selection)
    this.watched.add(sessionId)
    const summary = this.summaryFromMeta(sessionId, this.describeEvents(header, events), {
      updatedAt: this.lastSummaries.get(sessionId)?.updatedAt ?? Date.now(),
      cwd: header?.cwd ?? (cwd || this.defaultCwd),
    })
    this.metaCache.set(sessionId, { updatedAt: summary.updatedAt, meta: this.describeEvents(header, events) })
    if (live !== undefined) store.title = this.titleOf(live) || store.title
    if (!attached) {
      return {
        session: summary,
        items: store.snapshot(MAX_OPEN_ITEMS),
        configOptions,
        attached: false,
        warning: warning || '无法附着到 Host 会话，当前仅显示持久化历史',
      }
    }
    return {
      session: summary,
      items: store.snapshot(MAX_OPEN_ITEMS),
      configOptions,
      attached: true,
      warning,
    }
  }

  // ---------------------------------------------------------------------
  // Prompt / cancel
  // ---------------------------------------------------------------------

  /**
   * Admit one prompt into the live Agent and wait for its turn to settle.
   * @param {string} sessionId session identity.
   * @param {string} text prompt text.
   * @returns {Promise<{stopReason: string}>} terminal stop reason.
   */
  async prompt(sessionId, text) {
    if (this.inflight.has(sessionId)) {
      throw new RpcError(ERROR_CODES.INTERNAL, '该会话正在执行，请先取消或等待完成')
    }
    const agent = await this.requireAgent(sessionId)
    const session = agent.session ?? this.sessionOf(sessionId)
    if (session === undefined) throw this.wrapInternal('发送失败', new Error('会话不可用'))
    const store = this.ensureStore(sessionId)
    if (store.items.length === 0) store.reset(session.snapshotEvents(), { createdAt: session.header?.createdAt, cwd: session.header?.cwd })
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }
    const record = {
      messageId: message.id,
      turn: undefined,
      settled: false,
      cancelled: false,
      resolve: undefined,
      reject: undefined,
      outputError: undefined,
    }
    const result = new Promise((resolve, reject) => {
      record.resolve = resolve
      record.reject = reject
    })
    this.inflight.set(sessionId, record)
    this.broadcastSessionUpdated(sessionId)
    this.emitTurnStatus(sessionId, 'running', '')
    try {
      agent.followup(message)
    } catch (error) {
      this.settleInflight(sessionId, record, 'error', error)
      throw this.wrapInternal('发送失败', error)
    }
    if (this.pendingCancel.delete(sessionId)) {
      // A cancel arrived while the prompt was being admitted: clear the queued
      // message and settle immediately; no turn will be observed.
      record.cancelled = true
      agent.cancel({ kind: 'user' })
      this.settleInflight(sessionId, record, 'cancelled')
    }
    return result
  }

  /**
   * Cancel the active turn of a session (phone or desktop initiated).
   * @param {string} sessionId session identity.
   * @returns {Promise<Record<string, never>>} empty result.
   */
  async cancel(sessionId) {
    this.gateway?.cancelApprovalsForSession(sessionId)
    let agent = this.agentOf(sessionId)
    if (agent === undefined) {
      const found = await this.tryResumeAgent(sessionId)
      agent = found.agent
    }
    const record = this.inflight.get(sessionId)
    if (record !== undefined) record.cancelled = true
    if (agent !== undefined) agent.cancel({ kind: 'user' })
    if (record === undefined) {
      // The phone's prompt has not reached the Agent yet; remember the intent
      // so prompt() can settle it as cancelled after admission.
      this.pendingCancel.add(sessionId)
      return {}
    }
    if (!record.settled && record.turn === undefined) {
      // The queued user message was cleared before it was claimed; there is no
      // turn to observe, so settle the phone's prompt immediately.
      this.settleInflight(sessionId, record, 'cancelled')
    }
    return {}
  }

  /** Emit a turn status only when it changes. */
  emitTurnStatus(sessionId, status, stopReason = '') {
    const previous = this.lastTurnStatus.get(sessionId)
    if (previous === status) return
    this.lastTurnStatus.set(sessionId, status)
    this.emitEvent('turn.status', { sessionId, status, stopReason })
  }

  settleInflight(sessionId, record, stopReason, error) {
    if (record.settled) return
    record.settled = true
    this.debugCounters.settles += 1
    if (this.inflight.get(sessionId) === record) this.inflight.delete(sessionId)
    if (stopReason === 'error') {
      const message = errorMessage(error)
      const store = this.stores.get(sessionId)
      if (store !== undefined) {
        const item = store.addNotice(`执行失败：${message}`)
        this.emitEvent('item.upsert', { sessionId, item })
      }
      this.broadcastSessionUpdated(sessionId)
      this.emitTurnStatus(sessionId, 'idle', 'error')
      record.reject(new RpcError(ERROR_CODES.INTERNAL, `执行失败：${message}`))
      return
    }
    this.broadcastSessionUpdated(sessionId)
    this.emitTurnStatus(sessionId, 'idle', stopReason)
    record.resolve({ stopReason })
  }

  // ---------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------

  /**
   * Apply one phone config change through the Host model-selection seam.
   * @param {string} sessionId session identity.
   * @param {'model'|'reasoning_effort'} configId config option id.
   * @param {string} value selected value.
   * @returns {Promise<{configOptions: Array<Record<string, any>>}>} complete option state.
   */
  async setConfig(sessionId, configId, value) {
    await this.requireAgent(sessionId)
    const store = this.ensureStore(sessionId)
    const current = this.currentSelection(sessionId, store)
    if (current === undefined) throw this.wrapInternal('设置失败', new Error('该会话还没有模型选择'))
    let next
    if (configId === 'model') {
      let parsed
      try {
        parsed = JSON.parse(value)
      } catch {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, '模型值必须是 JSON 字符串 ["provider","model"]')
      }
      if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
        throw new RpcError(ERROR_CODES.INVALID_PARAMS, '模型值必须是 JSON 字符串 ["provider","model"]')
      }
      next = { provider: parsed[0], model: parsed[1] }
    } else if (configId === 'reasoning_effort') {
      next = {
        provider: current.provider,
        model: current.model,
        ...(value === '' ? {} : { reasoningEffort: value }),
      }
    } else {
      throw new RpcError(ERROR_CODES.INVALID_PARAMS, `未知配置项: ${configId}`)
    }
    const controller = this.requireController()
    let selected
    try {
      const result = await controller.selectModel({ sessionId, ...next })
      selected = result?.selected ?? next
    } catch (error) {
      throw this.wrapInternal('设置失败', error)
    }
    const configOptions = await this.configOptionsFor(sessionId, selected)
    return { configOptions }
  }

  async invalidateCatalogAndBroadcast() {
    this.invalidateCatalog()
    for (const sessionId of [...this.watched]) {
      try {
        const options = await this.configOptionsFor(sessionId, this.currentSelection(sessionId, this.stores.get(sessionId)))
        this.emitEvent('config.updated', { sessionId, configOptions: options })
      } catch {}
    }
  }

  invalidateCatalog() {
    this.catalog = undefined
    this.catalogAt = 0
    void this.invalidateCatalogAndBroadcast()
  }

  currentSelection(sessionId, store) {
    const fromStore = store?.currentSelection()
    if (fromStore !== undefined) return fromStore
    return this.selectionOfAgent(sessionId) ?? this.defaultSelection()
  }

  selectionOfAgent(sessionId) {
    const agent = this.agentOf(sessionId)
    const session = agent?.session ?? this.sessionOf(sessionId)
    if (session === undefined) return undefined
    try {
      const header = session.requestHeader()
      if (header?.config?.provider && header.config.model) {
        return {
          provider: String(header.config.provider),
          model: String(header.config.model),
          ...(header.config.reasoningEffort === undefined || header.config.reasoningEffort === ''
            ? {}
            : { reasoningEffort: String(header.config.reasoningEffort) }),
        }
      }
    } catch {}
    try {
      const projections = this.ctx.get('sessionProjections')
      const state = projections?.stateOf?.(session, 'modelSelection')
      const picked = state?.pending ?? state?.lastUsed
      if (picked?.provider && picked.model) return { ...picked }
    } catch {}
    return undefined
  }

  defaultSelection() {
    try {
      const current = this.ctx.get('agentDefaultModel')?.currentSelection?.()
      if (current?.provider && current.model) {
        return {
          provider: String(current.provider),
          model: String(current.model),
          ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: String(current.reasoningEffort) }),
        }
      }
    } catch {}
    return undefined
  }

  async getCatalog() {
    if (this.catalog !== undefined && Date.now() - this.catalogAt < 30_000) return this.catalog
    const controller = this.requireController()
    try {
      const catalog = await controller.modelCatalog()
      this.catalog = catalog
      this.catalogAt = Date.now()
      return catalog
    } catch (error) {
      throw this.wrapInternal('读取模型列表失败', error)
    }
  }

  /**
   * Build the phone's ConfigOption list from the live Host model catalog.
   * @param {string} _sessionId session identity.
   * @param {{provider: string, model: string, reasoningEffort?: string}|undefined} selection current selection.
   * @returns {Promise<Array<Record<string, any>>>} config options.
   */
  async configOptionsFor(_sessionId, selection) {
    const catalog = await this.getCatalog()
    const current = selection ?? catalog.default ?? this.defaultSelection()
    if (current === undefined) return []
    const modelChoices = []
    let currentGroup
    let currentModel
    for (const group of catalog.groups ?? []) {
      for (const model of group.models ?? []) {
        if (group.id === current.provider && model.id === current.model) {
          currentGroup = group
          currentModel = model
        }
        modelChoices.push({
          value: JSON.stringify([group.id, model.id]),
          name: String(model.name ?? model.id),
          group: String(group.name ?? group.id),
          description: String(model.description ?? ''),
        })
      }
    }
    const currentValue = JSON.stringify([current.provider, current.model])
    if (!modelChoices.some(choice => choice.value === currentValue)) {
      modelChoices.unshift({
        value: currentValue,
        name: currentModel?.name ?? current.model,
        group: currentGroup?.name ?? current.provider,
        description: '',
      })
    }
    const options = [{
      id: 'model',
      name: '模型',
      category: 'model',
      type: 'select',
      currentValue,
      choices: modelChoices,
    }]
    const reasoning = currentModel?.reasoning
    if (reasoning !== undefined && Array.isArray(reasoning.efforts) && reasoning.efforts.length > 0) {
      const choices = [{
        value: '',
        name: '默认',
        group: '',
        description: '使用模型默认推理强度',
      }]
      for (const effort of reasoning.efforts) {
        choices.push({
          value: String(effort.id),
          name: String(effort.name ?? effort.id),
          group: '',
          description: String(effort.description ?? ''),
        })
      }
      const selectedEffort = current.reasoningEffort === undefined ? '' : String(current.reasoningEffort)
      if (selectedEffort !== '' && !choices.some(choice => choice.value === selectedEffort)) {
        choices.push({ value: selectedEffort, name: selectedEffort, group: '', description: '' })
      }
      options.push({
        id: 'reasoning_effort',
        name: '推理强度',
        category: 'thought_level',
        type: 'select',
        currentValue: selectedEffort,
        choices,
      })
    }
    return options
  }

  // ---------------------------------------------------------------------
  // Event fan-out
  // ---------------------------------------------------------------------

  handleSessionEvent(session, event) {
    if (this.disposed) return
    this.debugCounters.sessionEvents += 1
    this.debugCounters.byType[event?.type ?? 'unknown'] = (this.debugCounters.byType[event?.type ?? 'unknown'] ?? 0) + 1
    const sessionId = String(session?.id ?? session?.header?.id ?? '')
    if (!sessionId || isSubagentSession(session)) return
    const store = this.stores.get(sessionId)
    if (store !== undefined) {
      const result = store.ingest(event)
      if (this.watched.has(sessionId)) {
        for (const item of result.items) {
          for (const snapshot of store.progressiveSnapshots(item)) {
            this.emitEvent('item.upsert', { sessionId, item: snapshot })
          }
        }
      }
      if (event.type === 'assistant/message') this.emitUsage(sessionId, session, event)
    }
    if (event.type === 'turn/end') this.settleTurn(sessionId, event)
    if (SUMMARY_EVENT_TYPES.has(event.type)) {
      if (event.type === 'turn/start' || event.type === 'turn/end') {
        this.broadcastSessionUpdated(sessionId)
      } else {
        this.broadcastSessionUpdatedSoon(sessionId)
      }
    }
    if (event.type === 'model/selection' && this.watched.has(sessionId)) {
      void this.broadcastConfigUpdated(sessionId)
    }
  }

  /** Settle the phone's in-flight prompt when its turn ends. */
  settleTurn(sessionId, event) {
    const record = this.inflight.get(sessionId)
    if (record === undefined || record.settled) {
      this.debugCounters.turnEndsWithoutInflight += 1
      return
    }
    const turn = Number(event.data?.turn)
    if (record.turn !== undefined && record.turn !== turn) return
    const reason = event.data?.reason ?? { kind: 'completed' }
    if (record.cancelled && (reason.kind === 'completed' || reason.kind === 'blocked' || reason.kind === 'max-tokens')) {
      this.settleInflight(sessionId, record, 'cancelled')
      return
    }
    switch (reason.kind) {
      case 'aborted':
      case 'interrupted':
        this.settleInflight(sessionId, record, 'cancelled')
        return
      case 'error':
        this.settleInflight(sessionId, record, 'error', reason.error ?? record.outputError ?? new Error('模型调用失败'))
        return
      case 'max-tokens':
        this.settleInflight(sessionId, record, 'max_tokens')
        return
      case 'blocked':
      case 'completed':
      case 'forked':
      default:
        this.settleInflight(sessionId, record, 'end_turn')
    }
  }

  async broadcastConfigUpdated(sessionId) {
    try {
      const store = this.stores.get(sessionId)
      const selection = store?.currentSelection() ?? this.selectionOfAgent(sessionId) ?? this.defaultSelection()
      const options = await this.configOptionsFor(sessionId, selection)
      if (!this.watched.has(sessionId)) return
      this.emitEvent('config.updated', { sessionId, configOptions: options })
    } catch (error) {
      this.logError(`[dsh-remote-mobile] config update failed: ${errorMessage(error)}`)
    }
  }

  emitUsage(sessionId, session, event) {
    try {
      const size = session.requestContext?.()?.contextWindow
      const meter = this.ctx.get('tokenMeter')
      if (size === undefined || meter === undefined) return
      const measured = meter.measure(session)
      const used = Number(measured?.totalTokens ?? measured?.used ?? 0)
      if (!Number.isFinite(used)) return
      this.emitEvent('usage.updated', { sessionId, used, size: Number(size) })
    } catch {}
  }

  handleInboxClaimed(payload) {
    this.debugCounters.claimed += 1
    const agent = payload?.agent
    const message = payload?.message
    const turn = payload?.turn
    if (agent === undefined || message === undefined) return
    const record = this.inflight.get(String(agent.id))
    if (record === undefined || record.settled) return
    if (record.messageId === message.id) record.turn = Number(turn)
  }

  handleAgentStatus(payload) {
    this.debugCounters.statuses += 1
    const agent = payload?.agent
    if (agent === undefined || isSubagentSession(agent.session)) return
    const sessionId = String(agent.id)
    const summary = this.refreshSummary(sessionId)
    if (this.lastSummaries.has(sessionId) || this.watched.has(sessionId)) {
      this.emitEvent('session.updated', { session: summary })
    }
    if (this.watched.has(sessionId)) {
      this.emitTurnStatus(sessionId, payload.status === 'running' ? 'running' : 'idle', '')
    }
  }

  handleAgentError(payload) {
    const agent = payload?.agent
    if (agent === undefined) return
    const sessionId = String(agent.id)
    const record = this.inflight.get(sessionId)
    if (record === undefined || record.settled) return
    record.outputError = payload.error
  }

  handleAgentDisposed(payload) {
    const agent = payload?.agent
    if (agent === undefined) return
    const sessionId = String(agent.id)
    const record = this.inflight.get(sessionId)
    if (record !== undefined && !record.settled) {
      this.settleInflight(sessionId, record, 'error', new Error('会话已关闭'))
    }
  }

  /**
   * Host approval answerer: forward only sessions a phone has opened.
   * Everything else falls through to the Harness' own answerers.
   */
  handleApprovalRequest(request, next) {
    const agent = request?.agent
    if (agent === undefined) return next()
    const sessionId = String(agent.id)
    if (!this.watched.has(sessionId)) return next()
    if ((this.gateway?.clientCount ?? 0) === 0) return next()
    const callId = request.callId === undefined ? '' : String(request.callId)
    const store = this.stores.get(sessionId)
    let input = ''
    let title = String(request.toolName ?? '工具')
    let label = toolLabel(title)
    if (callId) {
      let item = store?.items.find(entry => entry.kind === 'tool' && entry.toolCallId === callId)
      if (item === undefined) {
        // PTC/nested tool dispatches may approve a call whose durable event is not
        // projected into the phone item, or which is wrapped by `run_code`; fall
        // back to the most recent in-progress tool item for display context.
        item = [...(store?.items ?? [])].reverse().find(entry => entry.kind === 'tool' && entry.status === 'in_progress')
      }
      if (item !== undefined) {
        input = item.input
        title = item.title || title
        label = item.label || label
      } else {
        const call = this.findToolCall(agent.session, callId)
        if (call !== undefined) {
          title = call.name
          label = toolLabel(call.name)
          input = formatToolInput(call.arguments)
        }
      }
    }
    const friendly = toolLabel(request.toolName)
    if (friendly !== '工具调用') label = friendly
    const display = request.displayReason
    let reasonText = ''
    if (display !== undefined && typeof display === 'object') {
      reasonText = String(display.zh ?? display['zh-CN'] ?? display.en ?? '')
    }
    if (reasonText) {
      input = input ? `审批原因：${reasonText}\n\n${input}` : `审批原因：${reasonText}`
      input = truncate(input, 6000)
    }
    const approval = this.gateway.requestApproval({
      sessionId,
      toolCallId: callId,
      title,
      label,
      input,
      options: APPROVAL_OPTIONS,
    })
    const signal = request.signal
    if (signal === undefined) return approval
    return Promise.race([
      approval,
      new Promise(resolve => {
        const onAbort = () => {
          this.gateway?.cancelApprovalsForSession(sessionId)
          resolve('cancelled')
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  }

  findToolCall(session, callId) {
    try {
      const events = session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event.type === 'tool/call' && String(event.data?.callId ?? '') === callId) {
          return { name: String(event.data.name ?? '工具'), arguments: event.data.arguments }
        }
      }
    } catch {}
    return undefined
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  requireController() {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) {
      throw new RpcError(ERROR_CODES.INTERNAL, 'Host 未提供会话服务（sessionController）')
    }
    return controller
  }

  async requireAgent(sessionId) {
    const live = this.agentOf(sessionId)
    if (live !== undefined) return live
    const found = await this.tryResumeAgent(sessionId)
    if (found.agent === undefined) {
      throw new RpcError(ERROR_CODES.INTERNAL, found.error ?? `会话不可用: ${sessionId}`)
    }
    return found.agent
  }

  async tryResumeAgent(sessionId) {
    try {
      const controller = this.requireController()
      const result = await controller.resolveAgent(sessionId)
      if (result?.error !== undefined) {
        return { error: this.errorText(result.error) }
      }
      const agent = result?.agent ?? this.agentOf(sessionId)
      if (agent === undefined) return { error: `无法恢复会话: ${sessionId}` }
      return { agent }
    } catch (error) {
      return { error: this.errorText(error) }
    }
  }

  errorText(error) {
    if (error === null || error === undefined) return '未知错误'
    if (typeof error === 'string') return error
    if (error.message) return String(error.message)
    if (error.code && error.details) return `${error.code}: ${JSON.stringify(error.details)}`
    return errorMessage(error)
  }

  async inspectSession(sessionId) {
    const controller = this.requireController()
    try {
      const inspected = await controller.inspect(sessionId)
      return { header: inspected.meta ?? inspected.header, events: inspected.events ?? [] }
    } catch (error) {
      throw new RpcError(ERROR_CODES.INTERNAL, `会话不存在或无法读取: ${this.errorText(error)}`)
    }
  }

  ensureStore(sessionId) {
    let store = this.stores.get(sessionId)
    if (store === undefined) {
      store = new SessionItemStore(sessionId)
      this.stores.set(sessionId, store)
    }
    return store
  }

  normalizeCwd(cwd) {
    const requested = String(cwd ?? '').trim()
    if (!requested) return this.defaultCwd
    return requested
  }

  wrapInternal(prefix, error) {
    if (error instanceof RpcError) return error
    return new RpcError(ERROR_CODES.INTERNAL, `${prefix}: ${this.errorText(error)}`)
  }
}

/**
 * Extract the plain text of one message value.
 * @param {any} message message or event data.
 * @returns {string} concatenated text blocks.
 */
export function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('')
}
