/**
 * Converts Host Session events into the phone's ChatItem transcript format.
 *
 * Stable item ids (phone dedup contract):
 * - user message      `u:<messageId>`
 * - assistant text    `a:<messageId>`
 * - reasoning/thought `t:<messageId>`
 * - tool call/result  `tool:<toolCallId>`
 * - notice            `n:<uuid>` (created by the bridge, not derived from a log)
 *
 * Every item is always emitted complete; the phone replaces an item by id.
 *
 * @module dsh-remote-mobile/item-mapper
 */

import { randomUUID } from 'node:crypto'

import {
  MAX_ITEM_TEXT,
  MAX_ITEMS_PER_SESSION,
  MAX_TOOL_INPUT,
  MAX_TOOL_RESULT,
  previewText,
  toolLabel,
} from './protocol.js'

/**
 * Truncate text with an ellipsis marker.
 * @param {unknown} value raw text.
 * @param {number} limit maximum code units.
 * @returns {string} truncated text.
 */
export function truncate(value, limit) {
  const text = String(value ?? '')
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text
}

/** Empty phone item skeleton. */
export function emptyItem() {
  return {
    id: '',
    kind: 'notice',
    text: '',
    time: 0,
    title: '',
    label: '',
    status: '',
    toolCallId: '',
    input: '',
    result: '',
    collapsed: false,
  }
}

/** Copy the phone-visible fields of an item. */
export function copyItem(item) {
  return {
    id: String(item.id ?? ''),
    kind: String(item.kind ?? 'notice'),
    text: String(item.text ?? ''),
    time: Number(item.time ?? 0),
    title: String(item.title ?? ''),
    label: String(item.label ?? ''),
    status: String(item.status ?? ''),
    toolCallId: String(item.toolCallId ?? ''),
    input: String(item.input ?? ''),
    result: String(item.result ?? ''),
    collapsed: item.collapsed === true,
  }
}

/**
 * Render one content-block array as plain text with placeholders.
 * @param {unknown} content content block array or string.
 * @param {{ reasoning?: boolean, placeholders?: boolean }} [options] extraction options.
 * @returns {string} concatenated text.
 */
export function contentText(content, options = {}) {
  const parts = []
  collectContent(content, options, parts)
  return parts.join('')
}

function collectContent(content, options, parts) {
  if (content === undefined || content === null) return
  if (typeof content === 'string') {
    if (options.reasoning !== true) parts.push(content)
    return
  }
  if (Array.isArray(content)) {
    for (const block of content) collectContent(block, options, parts)
    return
  }
  if (typeof content !== 'object') return
  const block = /** @type {Record<string, any>} */ (content)
  if (block.type === 'text') {
    if (options.reasoning !== true && typeof block.text === 'string') parts.push(block.text)
    return
  }
  if (block.type === 'reasoning') {
    if (options.reasoning === true && typeof block.text === 'string') parts.push(block.text)
    return
  }
  if (options.reasoning === true) return
  if (options.placeholders === false) return
  if (block.type === 'image') {
    parts.push('\n[图片]\n')
    return
  }
  if (block.type === 'file') {
    const name = block.attachment?.name ?? block.name ?? ''
    parts.push(name ? `\n[文件 ${name}]\n` : '\n[文件]\n')
    return
  }
  if (block.type === 'tool-call') {
    // Tool calls are projected by their own durable `tool/call` event.
    return
  }
}

/**
 * Format a tool call's raw JSON arguments for display.
 * @param {unknown} args raw arguments string or value.
 * @returns {string} pretty, truncated input text.
 */
export function formatToolInput(args) {
  if (args === undefined || args === null) return ''
  if (typeof args === 'string') {
    const raw = args.trim()
    if (!raw) return ''
    try {
      const parsed = JSON.parse(raw)
      return truncate(JSON.stringify(parsed, null, 2), MAX_TOOL_INPUT)
    } catch {
      return truncate(raw, MAX_TOOL_INPUT)
    }
  }
  try {
    return truncate(JSON.stringify(args, null, 2), MAX_TOOL_INPUT)
  } catch {
    return truncate(String(args), MAX_TOOL_INPUT)
  }
}

/**
 * Render one tool result message content as display text.
 * @param {unknown} content tool result content blocks.
 * @returns {string} truncated result text.
 */
export function toolResultText(content) {
  return truncate(contentText(content, { placeholders: true }).trim(), MAX_TOOL_RESULT)
}

/**
 * Recent transcript store for one session. Rebuild it from a full event list
 * (`reset`) and then advance it with single committed events (`ingest`).
 */
export class SessionItemStore {
  /**
   * @param {string} sessionId owning session id.
   */
  constructor(sessionId) {
    this.sessionId = sessionId
    /** @type {Array<Record<string, any>>} */
    this.items = []
    /** @type {Map<string, Record<string, any>>} */
    this.byId = new Map()
    /** @type {Map<string, string>} */
    this.toolNames = new Map()
    this.title = ''
    this.preview = ''
    this.createdAt = 0
    this.cwd = ''
    this.hasTranscript = false
    this.lastUsage = undefined
    this.selection = { lastUsed: undefined, pending: undefined }
  }

  /**
   * Rebuild the store from a complete, chronological event list.
   * @param {Array<Record<string, any>>} events session events.
   * @param {{ createdAt?: number, cwd?: string, title?: string }} [header] session metadata.
   * @returns {Array<Record<string, any>>} the derived items (bounded).
   */
  reset(events, header = {}) {
    this.items = []
    this.byId.clear()
    this.toolNames.clear()
    this.title = header.title ?? ''
    this.preview = ''
    this.createdAt = header.createdAt ?? 0
    this.cwd = header.cwd ?? ''
    this.hasTranscript = false
    this.lastUsage = undefined
    this.selection = { lastUsed: undefined, pending: undefined }
    for (const event of events ?? []) this.ingest(event, { silent: true })
    if (!this.title) this.title = this.deriveTitle()
    return this.snapshot()
  }

  /**
   * Apply one committed Session event.
   * @param {Record<string, any>} event session event.
   * @param {{ silent?: boolean }} [options] suppress item list output.
   * @returns {{ items: Array<Record<string, any>>, titleChanged: boolean, previewChanged: boolean, running?: string }}
   *   items upserted by this event (complete phone items).
   */
  ingest(event, options = {}) {
    if (!event || typeof event.type !== 'string') {
      return { items: [], titleChanged: false, previewChanged: false }
    }
    const data = event.data ?? {}
    const time = Number(event.time ?? Date.now())
    const changed = []
    let titleChanged = false
    let previewChanged = false

    switch (event.type) {
      case 'user/message': {
        const sourceKind = data.source?.kind
        if (sourceKind !== 'user') break
        const text = contentText(data.content, { placeholders: true }).trim()
        if (!text) break
        const id = `u:${String(data.id ?? `seq-${event.seq}`)}`
        changed.push(this.upsert({
          id,
          kind: 'user',
          text: truncate(text, MAX_ITEM_TEXT),
          time,
        }))
        this.hasTranscript = true
        previewChanged = this.setPreview(text)
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        const messageId = String(message.id ?? `seq-${event.seq}`)
        const reasoning = contentText(message.content, { reasoning: true }).trim()
        if (reasoning) {
          changed.push(this.upsert({
            id: `t:${messageId}`,
            kind: 'thought',
            text: truncate(reasoning, MAX_ITEM_TEXT),
            time,
          }))
        }
        const text = contentText(message.content).trim()
        if (text) {
          changed.push(this.upsert({
            id: `a:${messageId}`,
            kind: 'assistant',
            text: truncate(text, MAX_ITEM_TEXT),
            time,
          }))
          previewChanged = this.setPreview(text)
        }
        this.hasTranscript = true
        if (data.usage) this.lastUsage = data.usage
        break
      }
      case 'tool/call': {
        const callId = String(data.callId ?? '')
        if (!callId) break
        const name = String(data.name ?? 'tool')
        this.toolNames.set(callId, name)
        const input = formatToolInput(data.arguments)
        changed.push(this.upsert({
          id: `tool:${callId}`,
          kind: 'tool',
          toolCallId: callId,
          title: name,
          label: toolLabel(name),
          status: 'in_progress',
          input,
          result: '',
          time,
        }))
        this.hasTranscript = true
        break
      }
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = String(message.toolCallId ?? data.callId ?? '')
        if (!callId) break
        const name = this.toolNames.get(callId) ?? 'tool'
        const failed = message.isError === true || data.error !== undefined
        const existing = this.byId.get(`tool:${callId}`)
        changed.push(this.upsert({
          id: `tool:${callId}`,
          kind: 'tool',
          toolCallId: callId,
          title: existing?.title ?? name,
          label: existing?.label ?? toolLabel(name),
          status: failed ? 'failed' : 'completed',
          input: existing?.input ?? '',
          result: toolResultText(message.content),
          time: existing?.time ?? time,
        }))
        this.hasTranscript = true
        break
      }
      case 'session/title': {
        const title = String(data.title ?? '').trim()
        if (title && title !== this.title) {
          this.title = title
          titleChanged = true
        }
        break
      }
      case 'model/selection': {
        this.selection.pending = normalizeSelection(data)
        break
      }
      case 'request/header': {
        const config = data.header?.config ?? {}
        const used = normalizeSelection(config)
        this.selection.lastUsed = used
        if (sameSelection(this.selection.pending, used)) this.selection.pending = undefined
        break
      }
      default:
        break
    }
    return { items: options.silent ? [] : changed, titleChanged, previewChanged }
  }

  /**
   * Current model selection folded from the log (pending override wins).
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
   */
  currentSelection() {
    return this.selection.pending ?? this.selection.lastUsed
  }

  /** Track a tool call that a stream frame announced before its durable event. */
  noteToolCall(callId, name) {
    if (callId && name) this.toolNames.set(callId, name)
  }

  /**
   * Add a local notice item (not durable; only present in this process).
   * @param {string} text notice text.
   * @returns {Record<string, any>} the stored item.
   */
  addNotice(text) {
    const id = `n:${randomUUID()}`
    return this.upsert({ id, kind: 'notice', text: truncate(text, MAX_ITEM_TEXT), time: Date.now() })
  }

  /**
   * Bounded snapshot of the recent transcript, in chronological order.
   * @param {number} [limit] maximum items.
   * @returns {Array<Record<string, any>>} full phone items.
   */
  snapshot(limit = MAX_ITEMS_FOR_OPEN) {
    const start = Math.max(0, this.items.length - limit)
    return this.items.slice(start).map(copyItem)
  }

  /**
   * Produce growing snapshots of a just-updated text item so the phone can
   * animate text arrival while still replacing one stable item id.
   * @param {Record<string, any>} item complete item.
   * @param {number} [steps] maximum snapshots.
   * @returns {Array<Record<string, any>>} snapshots, last one complete.
   */
  progressiveSnapshots(item, steps = 12) {
    const text = String(item.text ?? '')
    if (item.kind !== 'assistant' && item.kind !== 'thought') return [copyItem(item)]
    if (text.length <= 240) return [copyItem(item)]
    const count = Math.min(steps, Math.max(2, Math.ceil(text.length / 480)))
    const snapshots = []
    for (let index = 1; index <= count; index += 1) {
      const end = Math.floor((text.length * index) / count)
      snapshots.push(copyItem({ ...item, text: text.slice(0, end) }))
    }
    return snapshots
  }

  /** Derive the fallback title from the first user item. */
  deriveTitle() {
    for (const item of this.items) {
      if (item.kind === 'user' && item.text) return previewText(item.text.split('\n')[0], 48) || '新会话'
    }
    return ''
  }

  setPreview(text) {
    const next = previewText(text)
    if (!next) return false
    if (next === this.preview) return false
    this.preview = next
    return true
  }

  /**
   * Insert or update one item by id.
   * @param {Record<string, any>} patch item fields; unknown fields ignored.
   * @returns {Record<string, any>} the complete stored item.
   */
  upsert(patch) {
    const id = String(patch.id ?? '')
    let stored = this.byId.get(id)
    if (stored === undefined) {
      stored = emptyItem()
      stored.id = id
      this.byId.set(id, stored)
      this.items.push(stored)
      if (this.items.length > MAX_ITEMS_PER_SESSION) {
        const removed = this.items.splice(0, this.items.length - MAX_ITEMS_PER_SESSION)
        for (const entry of removed) this.byId.delete(entry.id)
      }
    }
    if (patch.kind !== undefined) stored.kind = patch.kind
    if (patch.text !== undefined) stored.text = String(patch.text)
    if (patch.time !== undefined) stored.time = Number(patch.time)
    if (patch.title !== undefined) stored.title = String(patch.title)
    if (patch.label !== undefined) stored.label = String(patch.label)
    if (patch.status !== undefined) stored.status = String(patch.status)
    if (patch.toolCallId !== undefined) stored.toolCallId = String(patch.toolCallId)
    if (patch.input !== undefined) stored.input = String(patch.input)
    if (patch.result !== undefined) stored.result = String(patch.result)
    if (patch.collapsed !== undefined) stored.collapsed = patch.collapsed === true
    return copyItem(stored)
  }
}

/** Open response item limit (mirrors the frozen phone bridge). */
export const MAX_ITEMS_FOR_OPEN = 200

function normalizeSelection(value) {
  if (!value || typeof value !== 'object') return undefined
  const provider = String(value.provider ?? '')
  const model = String(value.model ?? '')
  if (!provider || !model) return undefined
  const effort = value.reasoningEffort === undefined || value.reasoningEffort === null || value.reasoningEffort === ''
    ? undefined
    : String(value.reasoningEffort)
  return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
}

function sameSelection(left, right) {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
