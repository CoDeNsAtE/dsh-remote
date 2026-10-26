/**
 * Wire protocol constants and helpers for the DSH Remote mobile gateway.
 *
 * The phone application protocol is frozen: every constant, frame shape and
 * error code in this file mirrors `bridge/dsh-mobile-bridge.mjs` (the legacy
 * external ACP gateway) and `entry/src/main/ets/model/DshTypes.ets`.
 *
 * @module dsh-remote-mobile/protocol
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

export const PLUGIN_NAME = 'dsh-remote-mobile'
export const VERSION = '0.1.0'
export const SERVER_NAME = 'deepseek-harness'

/** The first frame must arrive within this window. */
export const AUTH_TIMEOUT_MS = 15_000
/** Pending approvals expire after ten minutes. */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000
/** Pending approvals are cancelled this long after the last client disconnects. */
export const APPROVAL_NO_CLIENT_MS = 30_000
/** A single WebSocket frame may not exceed this size. */
export const MAX_FRAME_BYTES = 1024 * 1024

export const MAX_ITEMS_PER_SESSION = 400
/** `session.open` returns at most this many transcript items. */
export const MAX_OPEN_ITEMS = 200
export const MAX_ITEM_TEXT = 60_000
export const MAX_TOOL_INPUT = 6_000
export const MAX_TOOL_RESULT = 16_000
export const MAX_PREVIEW = 96
export const MAX_TITLE = 48
export const MAX_SESSIONS = 80

/** JSON-RPC-ish error codes used by the frozen phone protocol. */
export const ERROR_CODES = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
})

export class RpcError extends Error {
  /**
   * @param {number} code JSON-RPC error code.
   * @param {string} message human-readable, returned to the phone verbatim.
   */
  constructor(code, message) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

export function invalidParams(message) {
  return new RpcError(ERROR_CODES.INVALID_PARAMS, message)
}

export function methodNotFound(method) {
  return new RpcError(ERROR_CODES.METHOD_NOT_FOUND, `未知方法: ${String(method)}`)
}

export function internalError(message) {
  return new RpcError(ERROR_CODES.INTERNAL, message)
}

/** Approval options required by the phone app, in phone option order. */
export const APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ optionId: 'allow-once', name: '允许一次', kind: 'allow_once' }),
  Object.freeze({ optionId: 'reject-once', name: '拒绝', kind: 'reject_once' }),
])

/** Friendly Chinese labels for the approval sheet. */
const TOOL_LABELS = Object.freeze({
  bash: '终端命令',
  shell: '终端命令',
  exec: '终端命令',
  terminal: '终端命令',
  pwsh: '终端命令',
  powershell: '终端命令',
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
  skill: '加载技能',
  mcp: 'MCP 工具',
  run_code: '执行代码',
  code: '执行代码',
})

/**
 * Map an internal tool name onto the phone's friendly label vocabulary.
 * @param {unknown} title tool name.
 * @returns {string} a Chinese label.
 */
export function toolLabel(title) {
  const key = String(title ?? '').toLowerCase()
  if (TOOL_LABELS[key]) return TOOL_LABELS[key]
  for (const [prefix, label] of Object.entries(TOOL_LABELS)) {
    if (key.startsWith(`${prefix}_`) || key.startsWith(`${prefix}.`) || key.startsWith(`${prefix}:`)) return label
  }
  return '工具调用'
}

/**
 * Validate a required non-empty string RPC parameter.
 * @param {Record<string, unknown> | undefined} params request params.
 * @param {string} key parameter name.
 * @returns {string} the value.
 */
export function requireString(params, key) {
  const value = params?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`缺少参数: ${key}`)
  }
  return value
}

/**
 * Optional string parameter with a fallback.
 * @param {Record<string, unknown> | undefined} params request params.
 * @param {string} key parameter name.
 * @param {string} fallback default value.
 * @returns {string} the value.
 */
export function optionalString(params, key, fallback = '') {
  const value = params?.[key]
  return typeof value === 'string' ? value : fallback
}

/**
 * Normalize the configured WebSocket path: leading slash, no trailing slash.
 * @param {string} value raw path.
 * @returns {string} normalized path, defaulting to `/dsh`.
 */
export function normalizeWsPath(value) {
  let path = String(value ?? '').trim()
  if (!path) return '/dsh'
  if (!path.startsWith('/')) path = `/${path}`
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path
}

/**
 * Constant-time string comparison for the access token.
 * @param {unknown} left presented value.
 * @param {unknown} right expected value.
 * @returns {boolean} whether they match.
 */
export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Mask a token for display: keep only the last four characters.
 * @param {string} token raw token.
 * @returns {string} masked display value.
 */
export function maskToken(token) {
  const value = String(token ?? '')
  if (!value) return ''
  if (value.length <= 4) return '****'
  return `${'*'.repeat(Math.min(24, value.length - 4))}${value.slice(-4)}`
}

/** Generate a URL-safe random token of at least 32 characters. */
export function generateToken() {
  return randomBytes(24).toString('base64url')
}

/**
 * Detect whether a host string binds every interface.
 * @param {string} host bind address.
 * @returns {boolean} true for wildcard binds.
 */
export function isWildcardHost(host) {
  return host === '0.0.0.0' || host === '::' || host === ''
}

/**
 * Remove fenced code blocks from text, replacing them with a marker.
 * @param {string} text raw text.
 * @returns {string} text without code fences.
 */
export function stripCodeFences(text) {
  return String(text ?? '').replace(/```[\s\S]*?```/g, ' [代码] ')
}

/**
 * Collapse whitespace and truncate text for previews.
 * @param {unknown} text raw text.
 * @param {number} limit maximum code units.
 * @returns {string} preview text.
 */
export function previewText(text, limit = MAX_PREVIEW) {
  const cleaned = stripCodeFences(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= limit) return cleaned
  return `${cleaned.slice(0, limit)}…`
}

/**
 * Derive the fallback session title from the first user prompt.
 * @param {string} text user prompt.
 * @returns {string} a short title.
 */
export function titleFromPrompt(text) {
  const firstLine = String(text ?? '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean) ?? ''
  if (!firstLine) return '新会话'
  return firstLine.length > MAX_TITLE ? `${firstLine.slice(0, MAX_TITLE)}…` : firstLine
}

/**
 * Build the `hello` / `server.info` payload.
 * @param {object} options hello fields.
 * @returns {object} hello frame body.
 */
export function helloPayload({ path, workspace, defaultCwd, online, agent, capabilities }) {
  return {
    name: PLUGIN_NAME,
    version: VERSION,
    path,
    workspace,
    defaultCwd,
    online,
    agent: {
      name: agent?.name ?? SERVER_NAME,
      version: agent?.version ?? '',
    },
    capabilities: capabilities ?? {},
  }
}
