#!/usr/bin/env node
/**
 * DSH Mobile Bridge
 *
 * Exposes DeepSeek Harness to the DSH Remote mobile app over one authenticated
 * WebSocket. The harness itself is driven through the official ACP profile
 * (`dsh --profile acp`, JSON-RPC over stdio), so plugins, skills, tools and the
 * harness approval flow all keep working unchanged.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { WebSocketServer } from 'ws'

const VERSION = '0.1.0'
const ACP_PROTOCOL_VERSION = 1
const WS_PATH = '/dsh'
const AUTH_TIMEOUT_MS = 15000
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
const MAX_ITEMS_PER_SESSION = 400
const MAX_SESSIONS = 80
const MAX_ITEM_TEXT = 60000
const MAX_TOOL_INPUT = 6000
const MAX_TOOL_RESULT = 16000

const TOOL_LABELS = {
  bash: '终端命令',
  shell: '终端命令',
  exec: '终端命令',
  terminal: '终端命令',
  read: '读取文件',
  read_file: '读取文件',
  write: '写入文件',
  write_file: '写入文件',
  edit: '编辑文件',
  str_replace_editor: '编辑文件',
  apply_patch: '修改代码',
  grep: '搜索内容',
  glob: '查找文件',
  ls: '浏览目录',
  list: '浏览目录',
  webfetch: '访问网页',
  web_fetch: '访问网页',
  fetch: '访问网页',
  websearch: '联网搜索',
  web_search: '联网搜索',
  task: '更新任务',
  todo: '更新任务',
  memory: '读写记忆',
  mcp: 'MCP 工具',
}

const HELP = `
DSH Mobile Bridge ${VERSION}

Usage:
  node dsh-mobile-bridge.mjs [options]

Options:
  --port <n>       WebSocket port (default: 8787)
  --host <addr>    Bind address (default: 0.0.0.0). Use 127.0.0.1 with an SSH tunnel.
  --token <str>    Access token. A random token is generated when omitted.
  --cwd <path>     Default workspace for new sessions (default: current directory)
  --dsh <command>  Harness command (default: "dsh --profile acp")
  --state <path>   Cache file (default: ~/.dsh-mobile-bridge/state.json)
  --help           Show this help

The token is required by the phone app. Anyone holding it can drive the agent,
including running commands in the workspace, so keep it private.
`.trim()

const { values: options } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '0.0.0.0' },
    token: { type: 'string' },
    cwd: { type: 'string' },
    dsh: { type: 'string', default: 'dsh --profile acp' },
    state: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

if (options.help) {
  console.log(HELP)
  process.exit(0)
}

const PORT = Number.parseInt(options.port, 10)
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid --port: ${options.port}`)
  process.exit(1)
}

const TOKEN = options.token?.trim() || randomBytes(18).toString('base64url')
if (TOKEN.length < 8) {
  console.error('The access token must contain at least 8 characters.')
  process.exit(1)
}

const WORKSPACE = resolve(options.cwd ?? process.cwd())
if (!isAbsolute(WORKSPACE)) {
  console.error(`Invalid workspace: ${WORKSPACE}`)
  process.exit(1)
}

const STATE_PATH = resolve(
  options.state ?? join(homedir(), '.dsh-mobile-bridge', 'state.json'),
)
const DSH_COMMAND = options.dsh

const clients = new Set()
const authedClients = new Set()
const pendingAcp = new Map()
const activeSessions = new Set()
const runningSessions = new Set()
const approvals = new Map()

let acpChild = null
let acpInit = null
let acpId = 0
let acpOnline = false
let agentInfo = { name: 'deepseek-harness-acp', version: '' }
let agentCapabilities = {}
let acpStderr = []
let approvalSeq = 0
let saveTimer = null
let lastClientAt = Date.now()

const state = loadState()

function log(...args) {
  console.log('[dsh-bridge]', ...args)
}

function logError(...args) {
  console.error('[dsh-bridge]', ...args)
}

function emptyState() {
  return { version: 1, sessions: {} }
}

function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return emptyState()
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sessions !== 'object') {
      return emptyState()
    }
    for (const session of Object.values(parsed.sessions)) {
      if (!session || typeof session !== 'object') continue
      session.items = Array.isArray(session.items) ? session.items : []
      session.configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
      session.running = false
      for (const item of session.items) {
        if (item?.kind === 'tool' && item.status === 'in_progress') {
          item.status = 'unknown'
        }
      }
    }
    log(`Loaded ${Object.keys(parsed.sessions).length} cached session(s).`)
    return parsed
  } catch (error) {
    logError(`Could not read state file, starting empty: ${error.message}`)
    return emptyState()
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(writeState, 600)
  saveTimer.unref?.()
}

function writeState() {
  saveTimer = null
  try {
    const entries = Object.values(state.sessions)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, MAX_SESSIONS)
    const sessions = {}
    for (const entry of entries) sessions[entry.sessionId] = entry
    state.sessions = sessions
    mkdirSync(dirname(STATE_PATH), { recursive: true })
    const temporary = `${STATE_PATH}.tmp`
    writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, STATE_PATH)
  } catch (error) {
    logError(`Could not persist state: ${error.message}`)
  }
}

function ensureMeta(sessionId, cwd) {
  let meta = state.sessions[sessionId]
  if (!meta) {
    meta = {
      sessionId,
      cwd: cwd || '',
      title: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      items: [],
      configOptions: [],
      running: false,
    }
    state.sessions[sessionId] = meta
    scheduleSave()
  } else if (cwd && !meta.cwd) {
    meta.cwd = cwd
  }
  return meta
}

function fallbackTitle(meta) {
  if (meta.cwd) {
    const name = basename(meta.cwd)
    if (name) return name
  }
  return `会话 ${meta.sessionId.slice(0, 6)}`
}

function previewOf(meta) {
  for (let index = meta.items.length - 1; index >= 0; index -= 1) {
    const item = meta.items[index]
    if (item.kind === 'user' || item.kind === 'assistant') {
      const text = String(item.text || '')
        .replace(/```[\s\S]*?```/g, ' [代码] ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) return text.length > 96 ? `${text.slice(0, 96)}…` : text
    }
  }
  return meta.cwd || '尚无消息'
}

function summaryOf(meta) {
  return {
    sessionId: meta.sessionId,
    cwd: meta.cwd || '',
    title: meta.title || fallbackTitle(meta),
    preview: previewOf(meta),
    createdAt: meta.createdAt ?? 0,
    updatedAt: meta.updatedAt ?? 0,
    running: runningSessions.has(meta.sessionId) || meta.running === true,
    hasTranscript: meta.items.length > 0,
  }
}

function truncate(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n…` : value
}

function stringifyInput(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return truncate(value, MAX_TOOL_INPUT)
  try {
    return truncate(JSON.stringify(value, null, 2), MAX_TOOL_INPUT)
  } catch {
    return truncate(String(value), MAX_TOOL_INPUT)
  }
}

function toolLabel(title) {
  const key = String(title || '').toLowerCase()
  if (TOOL_LABELS[key]) return TOOL_LABELS[key]
  for (const [prefix, label] of Object.entries(TOOL_LABELS)) {
    if (key.startsWith(`${prefix}_`) || key.startsWith(`${prefix}.`)) return label
  }
  return '工具调用'
}

function contentText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(contentText).join('')
  if (content.type === 'text') return content.text ?? ''
  if (content.type === 'image') return '\n[图片]\n'
  if (content.type === 'resource_link') {
    const name = content.name ?? 'resource'
    const uri = content.uri ?? ''
    return `\n[${name}](${uri})\n`
  }
  return ''
}

function toolResultText(content) {
  if (!Array.isArray(content)) return ''
  const chunks = []
  for (const entry of content) {
    if (entry?.type === 'content') chunks.push(contentText(entry.content))
    else if (entry?.type === 'diff') {
      chunks.push(`--- ${entry.path ?? ''}\n${entry.oldText ?? ''}\n+++\n${entry.newText ?? ''}`)
    } else if (entry?.type === 'terminal') {
      chunks.push(`[终端 ${entry.terminalId ?? ''}]`)
    }
  }
  return truncate(chunks.join('').trim(), MAX_TOOL_RESULT)
}

function addItem(meta, item) {
  let stored = meta.items.find(entry => entry.id === item.id)
  if (stored) {
    if (item.append && (stored.kind === 'assistant' || stored.kind === 'thought')) {
      stored.text = truncate(`${stored.text ?? ''}${item.text ?? ''}`, MAX_ITEM_TEXT)
    } else {
      Object.assign(stored, item)
      delete stored.append
      stored.text = truncate(stored.text ?? '', MAX_ITEM_TEXT)
    }
    stored.time = item.time ?? stored.time ?? Date.now()
    meta.updatedAt = Date.now()
  } else {
    stored = {
      id: item.id,
      kind: item.kind,
      text: truncate(item.text ?? '', MAX_ITEM_TEXT),
      time: item.time ?? Date.now(),
      title: item.title ?? '',
      label: item.label ?? '',
      status: item.status ?? '',
      toolCallId: item.toolCallId ?? '',
      input: item.input ?? '',
      result: item.result ?? '',
      collapsed: item.collapsed ?? false,
    }
    meta.items.push(stored)
    if (meta.items.length > MAX_ITEMS_PER_SESSION) {
      meta.items.splice(0, meta.items.length - MAX_ITEMS_PER_SESSION)
    }
    meta.updatedAt = Date.now()
  }
  scheduleSave()
  broadcast('item.upsert', { sessionId: meta.sessionId, item: stored })
  broadcast('session.updated', { session: summaryOf(meta) })
  return stored
}

function setRunning(sessionId, running, stopReason) {
  if (running) runningSessions.add(sessionId)
  else runningSessions.delete(sessionId)
  const meta = state.sessions[sessionId]
  if (meta) {
    meta.running = running
    meta.updatedAt = Date.now()
    scheduleSave()
    broadcast('session.updated', { session: summaryOf(meta) })
  }
  broadcast('turn.status', {
    sessionId,
    status: running ? 'running' : 'idle',
    stopReason: stopReason ?? '',
  })
}

function titleFromPrompt(text) {
  const firstLine = String(text || '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
  if (!firstLine) return '新会话'
  return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine
}

function sendFrame(socket, frame) {
  if (socket.readyState !== 1) return
  try {
    socket.send(JSON.stringify(frame))
  } catch (error) {
    logError(`WebSocket send failed: ${error.message}`)
  }
}

function broadcast(event, data) {
  const frame = { type: 'event', event, ...data }
  for (const socket of authedClients) {
    sendFrame(socket, frame)
  }
}

function broadcastStatus() {
  broadcast('bridge.status', {
    online: acpOnline,
    message: acpOnline ? '' : 'DSH 进程未连接',
  })
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function writeAcpFrame(frame) {
  if (!acpChild || acpChild.stdin.destroyed) {
    throw new Error('DSH 进程未运行')
  }
  acpChild.stdin.write(`${JSON.stringify(frame)}\n`)
}

function acpRequest(method, params, timeoutMs = 60000) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!acpChild || acpChild.exitCode !== null) {
      rejectPromise(new Error('DSH 进程未运行'))
      return
    }
    const id = ++acpId
    let timer = null
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pendingAcp.delete(id)
        rejectPromise(new Error(`DSH 请求超时: ${method}`))
      }, timeoutMs)
      timer.unref?.()
    }
    pendingAcp.set(id, {
      resolve: value => {
        if (timer) clearTimeout(timer)
        resolvePromise(value)
      },
      reject: error => {
        if (timer) clearTimeout(timer)
        rejectPromise(error)
      },
    })
    try {
      writeAcpFrame({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      pendingAcp.delete(id)
      if (timer) clearTimeout(timer)
      rejectPromise(error)
    }
  })
}

function acpNotify(method, params) {
  writeAcpFrame({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
}

function spawnAgent() {
  log(`Starting harness: ${DSH_COMMAND}`)
  acpStderr = []
  const child = spawn(DSH_COMMAND, {
    shell: true,
    cwd: WORKSPACE,
    windowsHide: true,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  acpChild = child

  const reader = createInterface({ input: child.stdout })
  reader.on('line', line => {
    const trimmed = line.trim()
    if (!trimmed) return
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      logError(`Ignoring non-JSON harness output: ${trimmed.slice(0, 300)}`)
      return
    }
    handleAcpMessage(message)
  })

  child.stderr.on('data', chunk => {
    const text = chunk.toString()
    process.stderr.write(text)
    for (const line of text.split('\n')) {
      if (line.trim()) acpStderr.push(line.trim())
    }
    if (acpStderr.length > 60) acpStderr.splice(0, acpStderr.length - 60)
  })

  child.on('error', error => {
    logError(`Harness process error: ${error.message}`)
    markAgentOffline(`启动 DSH 失败: ${error.message}`)
  })

  child.on('exit', (code, signal) => {
    logError(`Harness exited (code=${code}, signal=${signal ?? ''})`)
    if (acpChild === child) {
      markAgentOffline(`DSH 已退出 (${code ?? signal ?? 'unknown'})`)
    }
  })
}

function markAgentOffline(reason) {
  acpOnline = false
  acpInit = null
  activeSessions.clear()
  for (const sessionId of [...runningSessions]) setRunning(sessionId, false, 'error')
  for (const [id, pending] of pendingAcp) {
    pending.reject(new Error(reason))
    pendingAcp.delete(id)
  }
  for (const [requestId, approval] of [...approvals]) {
    finishApproval(requestId, null, 'cancelled')
  }
  const tail = acpStderr.slice(-6).join('\n')
  broadcastStatus()
  if (tail) logError(`Harness stderr tail:\n${tail}`)
  if (acpChild) {
    acpChild = null
  }
}

function stopAgent() {
  const child = acpChild
  acpChild = null
  acpInit = null
  if (!child || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
  } catch (error) {
    logError(`Could not stop harness: ${error.message}`)
  }
}

async function initializeAgent() {
  const response = await acpRequest('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
    clientInfo: { name: 'dsh-mobile-bridge', version: VERSION },
  }, 60000)
  agentInfo = response?.agentInfo ?? { name: 'deepseek-harness-acp', version: '' }
  agentCapabilities = response?.agentCapabilities ?? {}
  acpOnline = true
  log(`Harness ready: ${agentInfo.name ?? 'dsh'} ${agentInfo.version ?? ''}`.trim())
  broadcastStatus()
  return response
}

function ensureAgent() {
  if (acpInit && acpChild && acpChild.exitCode === null) return acpInit
  acpInit = (async () => {
    if (!acpChild || acpChild.exitCode !== null) spawnAgent()
    return initializeAgent()
  })().catch(error => {
    stopAgent()
    markAgentOffline(`DSH 初始化失败: ${error.message}`)
    throw error
  })
  return acpInit
}

function handleAcpMessage(message) {
  if (!message || typeof message !== 'object') return
  const hasId = message.id !== undefined && message.id !== null
  const hasMethod = typeof message.method === 'string'

  if (hasId && hasMethod) {
    void handleAgentRequest(message)
    return
  }

  if (hasMethod) {
    handleAgentNotification(message)
    return
  }

  if (hasId) {
    const pending = pendingAcp.get(message.id)
    if (!pending) return
    pendingAcp.delete(message.id)
    if (message.error) {
      const error = new Error(message.error.message ?? 'DSH 请求失败')
      error.code = message.error.code
      error.data = message.error.data
      pending.reject(error)
    } else {
      pending.resolve(message.result ?? {})
    }
  }
}

function tryWriteAcpFrame(frame) {
  try {
    writeAcpFrame(frame)
  } catch {
    // The harness has exited; the pending call is already rejected.
  }
}

async function handleAgentRequest(message) {
  try {
    let result
    if (message.method === 'session/request_permission') {
      result = await requestApproval(message)
    } else if (message.method === 'session/update') {
      result = {}
    } else {
      const error = new Error(`Unsupported agent request: ${message.method}`)
      error.code = -32601
      throw error
    }
    tryWriteAcpFrame({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    tryWriteAcpFrame({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: error.code ?? -32603, message: error.message ?? 'bridge error' },
    })
  }
}

function handleAgentNotification(message) {
  if (message.method === 'session/update') {
    handleSessionUpdate(message.params)
  }
}

function handleSessionUpdate(params) {
  if (!params || typeof params.sessionId !== 'string') return
  const update = params.update
  if (!update || typeof update !== 'object') return
  const meta = ensureMeta(params.sessionId, '')

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      if (!text) return
      const key = update.messageId || `turn-${meta.items.length}`
      addItem(meta, {
        id: `a:${key}`,
        kind: 'assistant',
        text,
        append: true,
        time: Date.now(),
      })
      return
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      if (!text) return
      const key = update.messageId || `turn-${meta.items.length}`
      addItem(meta, {
        id: `t:${key}`,
        kind: 'thought',
        text,
        append: true,
        time: Date.now(),
      })
      return
    }
    case 'tool_call': {
      const toolCallId = update.toolCallId || randomUUID()
      addItem(meta, {
        id: `tool:${toolCallId}`,
        kind: 'tool',
        toolCallId,
        title: update.title || 'tool',
        label: toolLabel(update.title),
        status: update.status || 'in_progress',
        input: stringifyInput(update.rawInput),
        result: '',
        time: Date.now(),
      })
      return
    }
    case 'tool_call_update': {
      const toolCallId = update.toolCallId || ''
      const existing = meta.items.find(item => item.toolCallId === toolCallId)
      addItem(meta, {
        id: `tool:${toolCallId}`,
        kind: 'tool',
        toolCallId,
        title: update.title || existing?.title || 'tool',
        label: toolLabel(update.title || existing?.title),
        status: update.status || existing?.status || 'completed',
        input: existing?.input ?? '',
        result: toolResultText(update.content),
        time: existing?.time ?? Date.now(),
      })
      return
    }
    case 'config_option_update': {
      meta.configOptions = normalizeConfigOptions(update.configOptions)
      scheduleSave()
      broadcast('config.updated', {
        sessionId: meta.sessionId,
        configOptions: meta.configOptions,
      })
      return
    }
    case 'usage_update': {
      broadcast('usage.updated', {
        sessionId: meta.sessionId,
        used: Number(update.used ?? 0),
        size: Number(update.size ?? 0),
      })
      return
    }
    case 'session_info_update': {
      if (typeof update.title === 'string' && update.title.trim()) {
        meta.title = update.title.trim()
        meta.updatedAt = Date.now()
        scheduleSave()
        broadcast('session.updated', { session: summaryOf(meta) })
      }
      return
    }
    default:
      return
  }
}

function normalizeConfigOptions(options) {
  if (!Array.isArray(options)) return []
  const normalized = []
  for (const option of options) {
    if (!option || typeof option !== 'object') continue
    const choices = []
    if (Array.isArray(option.options)) {
      for (const entry of option.options) {
        if (entry && Array.isArray(entry.options)) {
          for (const sub of entry.options) {
            if (!sub || typeof sub !== 'object') continue
            choices.push({
              value: String(sub.value ?? ''),
              name: String(sub.name ?? sub.value ?? ''),
              group: String(entry.name ?? entry.group ?? ''),
              description: String(sub.description ?? ''),
            })
          }
        } else if (entry && entry.value !== undefined) {
          choices.push({
            value: String(entry.value ?? ''),
            name: String(entry.name ?? entry.value ?? ''),
            group: '',
            description: String(entry.description ?? ''),
          })
        }
      }
    }
    normalized.push({
      id: String(option.id ?? ''),
      name: String(option.name ?? option.id ?? ''),
      category: String(option.category ?? ''),
      type: String(option.type ?? ''),
      currentValue: String(option.currentValue ?? ''),
      choices,
    })
  }
  return normalized
}

function requestApproval(message) {
  const params = message.params ?? {}
  const sessionId = String(params.sessionId ?? '')
  const toolCallId = String(params.toolCall?.toolCallId ?? '')
  const meta = ensureMeta(sessionId, '')
  const tool = meta.items.find(item => item.toolCallId === toolCallId)
  const requestId = `ap-${++approvalSeq}`
  const options = Array.isArray(params.options)
    ? params.options.map(option => ({
      optionId: String(option.optionId ?? ''),
      name: String(option.name ?? option.optionId ?? ''),
      kind: String(option.kind ?? ''),
    }))
    : []

  return new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      finishApproval(requestId, null, 'timeout')
    }, APPROVAL_TIMEOUT_MS)
    timer.unref?.()

    approvals.set(requestId, {
      requestId,
      sessionId,
      toolCallId,
      title: tool?.title || '工具调用',
      label: tool?.label || toolLabel(tool?.title),
      input: tool?.input || '',
      options,
      timer,
      resolve: outcome => resolvePromise(outcome),
    })

    broadcast('approval.request', {
      requestId,
      sessionId,
      toolCallId,
      title: tool?.title || '工具调用',
      label: tool?.label || toolLabel(tool?.title),
      input: tool?.input || '',
      options,
    })
    log(`Approval requested: ${tool?.label || toolLabel(tool?.title)} (${requestId})`)
  })
}

function finishApproval(requestId, optionId, reason) {
  const approval = approvals.get(requestId)
  if (!approval) return false
  clearTimeout(approval.timer)
  approvals.delete(requestId)

  let outcome
  if (optionId && approval.options.some(option => option.optionId === optionId)) {
    outcome = { outcome: 'selected', optionId }
  } else {
    outcome = { outcome: 'cancelled' }
  }
  approval.resolve(outcome)
  broadcast('approval.resolved', {
    requestId,
    sessionId: approval.sessionId,
    decision: optionId ? 'selected' : 'cancelled',
    optionId: optionId || '',
    reason: reason || '',
  })
  log(`Approval ${requestId} -> ${optionId || 'cancelled'}${reason ? ` (${reason})` : ''}`)
  return true
}

async function listAllSessions() {
  const sessions = []
  let cursor
  for (let page = 0; page < 20; page += 1) {
    const response = await acpRequest('session/list', cursor ? { cursor } : {}, 45000)
    const batch = Array.isArray(response?.sessions) ? response.sessions : []
    for (const entry of batch) {
      if (!entry || typeof entry.sessionId !== 'string') continue
      sessions.push({
        sessionId: entry.sessionId,
        cwd: typeof entry.cwd === 'string' ? entry.cwd : '',
      })
    }
    cursor = response?.nextCursor
    if (!cursor) break
  }
  return sessions
}

async function listSessions() {
  let online = false
  let warning = ''
  let remote = []
  try {
    await ensureAgent()
    remote = await listAllSessions()
    online = true
  } catch (error) {
    warning = error.message ?? String(error)
    logError(`session/list unavailable: ${warning}`)
  }

  const merged = []
  const seen = new Set()
  remote.forEach((entry, index) => {
    seen.add(entry.sessionId)
    const meta = state.sessions[entry.sessionId]
    if (meta) {
      if (entry.cwd) meta.cwd = entry.cwd
      merged.push({ ...summaryOf(meta), order: index })
    } else {
      const transient = {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        title: entry.cwd ? basename(entry.cwd) || '会话' : `会话 ${entry.sessionId.slice(0, 6)}`,
        preview: entry.cwd || '手机端暂无历史记录',
        createdAt: 0,
        updatedAt: 0,
        running: false,
        hasTranscript: false,
      }
      merged.push({ ...transient, order: index })
    }
  })

  for (const meta of Object.values(state.sessions)) {
    if (seen.has(meta.sessionId)) continue
    if (!meta.items.length && !activeSessions.has(meta.sessionId)) continue
    merged.push({ ...summaryOf(meta), order: 100000 })
  }

  merged.sort((left, right) => {
    const updated = (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
    if (updated !== 0) return updated
    return (left.order ?? 0) - (right.order ?? 0)
  })
  for (const item of merged) delete item.order
  return { sessions: merged, online, warning }
}

async function openSession(params) {
  const sessionId = requireString(params, 'sessionId')
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : ''
  const meta = ensureMeta(sessionId, cwd)
  let warning = ''

  if (!activeSessions.has(sessionId)) {
    try {
      await ensureAgent()
      const response = await acpRequest('session/resume', {
        sessionId,
        cwd: meta.cwd || WORKSPACE,
        mcpServers: [],
      }, 90000)
      activeSessions.add(sessionId)
      if (response?.configOptions) {
        meta.configOptions = normalizeConfigOptions(response.configOptions)
        scheduleSave()
      }
    } catch (error) {
      warning = error.message ?? String(error)
      logError(`session/resume failed: ${warning}`)
      if (meta.items.length === 0) throw new Error(warning)
      return {
        session: summaryOf(meta),
        items: meta.items,
        configOptions: meta.configOptions,
        attached: false,
        warning,
      }
    }
  }

  return {
    session: summaryOf(meta),
    items: meta.items,
    configOptions: meta.configOptions,
    attached: true,
    warning,
  }
}

async function newSession(params) {
  await ensureAgent()
  const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : WORKSPACE
  if (!isAbsolute(cwd)) throw new Error('工作目录必须是绝对路径')
  const response = await acpRequest('session/new', { cwd, mcpServers: [] }, 90000)
  const sessionId = requireString(response, 'sessionId')
  const meta = ensureMeta(sessionId, cwd)
  meta.title = '新会话'
  meta.createdAt = Date.now()
  meta.updatedAt = Date.now()
  meta.items = []
  meta.configOptions = normalizeConfigOptions(response.configOptions)
  activeSessions.add(sessionId)
  scheduleSave()
  setRunning(sessionId, false)
  return {
    session: summaryOf(meta),
    configOptions: meta.configOptions,
  }
}

async function promptSession(params) {
  const sessionId = requireString(params, 'sessionId')
  const text = requireString(params, 'text')
  if (!text.trim()) throw new Error('消息不能为空')
  if (runningSessions.has(sessionId)) throw new Error('该会话正在执行，请先取消或等待完成')
  await ensureAgent()
  const meta = ensureMeta(sessionId, '')
  if (!meta.cwd) meta.cwd = WORKSPACE

  const previousTitle = meta.title
  const userItem = {
    id: `u:${randomUUID()}`,
    kind: 'user',
    text,
    time: Date.now(),
  }
  addItem(meta, userItem)
  if (!meta.title || meta.title === '新会话') {
    meta.title = titleFromPrompt(text)
    scheduleSave()
    broadcast('session.updated', { session: summaryOf(meta) })
  }

  setRunning(sessionId, true)
  try {
    const response = await acpRequest('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, 0)
    setRunning(sessionId, false, response?.stopReason ?? 'end_turn')
    return { stopReason: response?.stopReason ?? 'end_turn' }
  } catch (error) {
    const message = error.message ?? String(error)
    addItem(meta, {
      id: `n:${randomUUID()}`,
      kind: 'notice',
      text: `执行失败：${message}`,
      time: Date.now(),
    })
    setRunning(sessionId, false, 'error')
    meta.title = previousTitle || meta.title
    throw error
  }
}

async function cancelSession(params) {
  const sessionId = requireString(params, 'sessionId')
  await ensureAgent()
  acpNotify('session/cancel', { sessionId })
  for (const [requestId, approval] of [...approvals]) {
    if (approval.sessionId === sessionId) finishApproval(requestId, null, 'cancelled')
  }
  return {}
}

async function setConfig(params) {
  const sessionId = requireString(params, 'sessionId')
  const configId = requireString(params, 'configId')
  const value = requireString(params, 'value')
  await ensureAgent()
  const response = await acpRequest('session/set_config_option', {
    sessionId,
    configId,
    value,
  }, 60000)
  const meta = ensureMeta(sessionId, '')
  meta.configOptions = normalizeConfigOptions(response?.configOptions)
  scheduleSave()
  broadcast('config.updated', { sessionId, configOptions: meta.configOptions })
  return { configOptions: meta.configOptions }
}

function requireString(source, key) {
  const value = source?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing parameter: ${key}`)
  }
  return value
}

function serverInfo() {
  return {
    name: 'dsh-mobile-bridge',
    version: VERSION,
    path: WS_PATH,
    workspace: WORKSPACE,
    defaultCwd: WORKSPACE,
    online: acpOnline,
    agent: agentInfo,
    capabilities: agentCapabilities,
  }
}

const rpcHandlers = {
  'ping': async () => ({ time: Date.now() }),
  'server.info': async () => serverInfo(),
  'sessions.list': async () => listSessions(),
  'session.new': async params => newSession(params ?? {}),
  'session.open': async params => openSession(params ?? {}),
  'session.prompt': async params => promptSession(params ?? {}),
  'session.cancel': async params => cancelSession(params ?? {}),
  'session.setConfig': async params => setConfig(params ?? {}),
  'approval.respond': async params => {
    const requestId = requireString(params, 'requestId')
    const optionId = typeof params.optionId === 'string' ? params.optionId : ''
    if (!approvals.has(requestId)) throw new Error('授权请求已失效')
    finishApproval(requestId, optionId || null, 'user')
    return { ok: true }
  },
}

async function handleRpc(socket, frame) {
  const id = frame.id
  if (id === undefined || id === null) return
  const handler = rpcHandlers[frame.method]
  if (!handler) {
    sendFrame(socket, {
      type: 'rpc.error',
      id,
      error: { code: -32601, message: `未知方法: ${frame.method}` },
    })
    return
  }
  try {
    const result = await handler(frame.params)
    sendFrame(socket, { type: 'rpc.result', id, result: result ?? {} })
  } catch (error) {
    const message = error.message ?? String(error)
    logError(`RPC ${frame.method} failed: ${message}`)
    sendFrame(socket, {
      type: 'rpc.error',
      id,
      error: { code: error.code ?? -32603, message },
    })
  }
}

const httpServer = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname === '/' || url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      name: 'dsh-mobile-bridge',
      version: VERSION,
    }))
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain' })
  response.end('DSH Mobile Bridge: connect over WebSocket at /dsh')
})

const wss = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  if (url.pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, ws => {
    wss.emit('connection', ws, request)
  })
})

wss.on('connection', socket => {
  let authenticated = false
  clients.add(socket)
  lastClientAt = Date.now()

  const authTimer = setTimeout(() => {
    if (!authenticated) {
      sendFrame(socket, { type: 'auth.error', message: '认证超时' })
      socket.close(4401, 'auth timeout')
    }
  }, AUTH_TIMEOUT_MS)
  authTimer.unref?.()

  socket.on('message', raw => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!frame || typeof frame !== 'object') return

    if (!authenticated) {
      if (frame.type !== 'auth' || !safeEqual(frame.token ?? '', TOKEN)) {
        sendFrame(socket, { type: 'auth.error', message: '访问令牌不正确' })
        socket.close(4401, 'unauthorized')
        return
      }
      authenticated = true
      authedClients.add(socket)
      clearTimeout(authTimer)
      sendFrame(socket, { type: 'hello', ...serverInfo() })
      for (const approval of approvals.values()) {
        sendFrame(socket, {
          type: 'event',
          event: 'approval.request',
          requestId: approval.requestId,
          sessionId: approval.sessionId,
          toolCallId: approval.toolCallId,
          title: approval.title,
          label: approval.label,
          input: approval.input,
          options: approval.options,
        })
      }
      log(`Phone connected (${authedClients.size} client(s))`)
      return
    }

    if (frame.type === 'rpc') {
      void handleRpc(socket, frame)
      return
    }
    if (frame.type === 'ping') {
      sendFrame(socket, { type: 'pong', time: Date.now() })
    }
  })

  socket.on('close', () => {
    clients.delete(socket)
    authedClients.delete(socket)
    lastClientAt = Date.now()
    log(`Phone disconnected (${authedClients.size} client(s))`)
  })

  socket.on('error', error => {
    logError(`WebSocket error: ${error.message}`)
  })
})

setInterval(() => {
  if (authedClients.size === 0 && approvals.size > 0 && Date.now() - lastClientAt > 30000) {
    for (const requestId of [...approvals.keys()]) {
      finishApproval(requestId, null, 'no-client')
    }
  }
}, 15000).unref?.()

httpServer.listen(PORT, options.host, () => {
  const addresses = collectAddresses(options.host, PORT)
  console.log('')
  console.log(`  DSH Remote Bridge ${VERSION}`)
  console.log('  ─────────────────────────────────────────────')
  console.log(`  WebSocket   ${addresses[0] ?? `ws://127.0.0.1:${PORT}${WS_PATH}`}`)
  for (const address of addresses.slice(1)) {
    console.log(`              ${address}`)
  }
  console.log(`  Token       ${TOKEN}`)
  console.log(`  Workspace   ${WORKSPACE}`)
  console.log(`  Harness     ${DSH_COMMAND}`)
  console.log('  ─────────────────────────────────────────────')
  console.log('  Open the app, enter the WebSocket URL and token above.')
  console.log('  Anyone with this token can run agent tools. Keep it private.')
  console.log('')
})

function collectAddresses(host, port) {
  if (host !== '0.0.0.0' && host !== '::') {
    return [`ws://${host}:${port}${WS_PATH}`]
  }
  const addresses = []
  const interfaces = networkInterfaces()
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      addresses.push(`ws://${entry.address}:${port}${WS_PATH}`)
    }
  }
  addresses.sort((left, right) => {
    const privateA = /^ws:\/\/192\.168\.|^ws:\/\/10\.|^ws:\/\/172\.(1[6-9]|2\d|3[01])\./.test(left)
    const privateB = /^ws:\/\/192\.168\.|^ws:\/\/10\.|^ws:\/\/172\.(1[6-9]|2\d|3[01])\./.test(right)
    return Number(privateB) - Number(privateA)
  })
  addresses.push(`ws://127.0.0.1:${port}${WS_PATH}`)
  return addresses
}

function shutdown() {
  log('Shutting down…')
  for (const requestId of [...approvals.keys()]) {
    finishApproval(requestId, null, 'shutdown')
  }
  writeState()
  for (const socket of authedClients) {
    try {
      socket.close(1001, 'bridge shutdown')
    } catch {
      // Ignore.
    }
  }
  stopAgent()
  httpServer.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1200).unref?.()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', error => {
  logError(`Uncaught exception: ${error.stack ?? error.message}`)
})
