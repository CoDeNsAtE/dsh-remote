/**
 * Session-event to ChatItem mapping tests (stable ids, merging, status,
 * placeholders, truncation, selection fold).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SessionItemStore,
  contentText,
  formatToolInput,
  toolResultText,
} from '../lib/item-mapper.js'

function event(type, data, extras = {}) {
  return { type, seq: extras.seq ?? 0, time: extras.time ?? 1_700_000_000_000, data, ...extras }
}

function userMessage(id, text) {
  return event('user/message', {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

function assistantMessage(id, blocks) {
  return event('assistant/message', {
    turn: 1,
    step: 1,
    message: { id, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' } },
    stream: [],
  })
}

test('history conversion follows the frozen id and merge rules', () => {
  const store = new SessionItemStore('s1')
  const items = store.reset([
    userMessage('m1', '帮我跑一下测试'),
    assistantMessage('m2', [
      { type: 'reasoning', text: '先看看项目结构' },
      { type: 'text', text: '我来运行测试。' },
    ]),
    event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }),
    event('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'm3',
        role: 'tool',
        toolCallId: 'c1',
        content: [{ type: 'text', text: '12 tests passed' }],
        isError: false,
      },
    }),
    event('session/title', { title: '帮我跑一下测试', messageSeqs: [], source: { kind: 'fallback' } }),
  ])
  assert.deepEqual(items.map(item => item.id), ['u:m1', 't:m2', 'a:m2', 'tool:c1'])
  assert.deepEqual(items.map(item => item.kind), ['user', 'thought', 'assistant', 'tool'])
  assert.equal(items[0].text, '帮我跑一下测试')
  assert.equal(items[1].text, '先看看项目结构')
  assert.equal(items[2].text, '我来运行测试。')
  assert.equal(items[3].title, 'bash')
  assert.equal(items[3].label, '终端命令')
  assert.equal(items[3].status, 'completed')
  assert.equal(items[3].toolCallId, 'c1')
  assert.match(items[3].input, /npm test/)
  assert.equal(items[3].result, '12 tests passed')
  assert.equal(store.title, '帮我跑一下测试')
  assert.equal(store.hasTranscript, true)
  assert.ok(store.preview.includes('12 tests passed') || store.preview.includes('我来运行测试'))
})

test('a failed tool result flips the same tool item to failed', () => {
  const store = new SessionItemStore('s2')
  store.ingest(event('tool/call', { callId: 'c9', name: 'read_file', arguments: '{"path":"a.txt"}' }))
  assert.equal(store.byId.get('tool:c9').status, 'in_progress')
  const update = store.ingest(event('tool/result', {
    message: {
      id: 'm4',
      role: 'tool',
      toolCallId: 'c9',
      content: [{ type: 'text', text: 'file not found' }],
      isError: true,
    },
    error: { name: 'ToolError', code: 'ENOENT' },
  }))
  assert.equal(update.items.length, 1)
  assert.equal(update.items[0].id, 'tool:c9')
  assert.equal(update.items[0].status, 'failed')
  assert.equal(update.items[0].result, 'file not found')
  assert.match(update.items[0].label, /读取文件/)
})

test('tool results use placeholders for non-text content', () => {
  assert.equal(toolResultText([{ type: 'image', attachment: { attachmentId: 'a' } }]), '[图片]')
  assert.match(toolResultText([{ type: 'file', attachment: { name: 'report.pdf', bytes: 3 } }]), /report\.pdf/)
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
})

test('tool input is pretty printed and truncated', () => {
  const formatted = formatToolInput('{"a":1}')
  assert.match(formatted, /"a": 1/)
  assert.equal(formatToolInput('not-json'), 'not-json')
  assert.ok(formatToolInput(`{"blob":"${'x'.repeat(7000)}"}`).length <= 6002)
})

test('text growth re-sends one complete item for the same id', () => {
  const store = new SessionItemStore('s3')
  store.ingest(userMessage('m1', 'hi'))
  store.ingest(assistantMessage('m2', [{ type: 'text', text: 'first' }]))
  const second = store.ingest(assistantMessage('m2', [{ type: 'text', text: 'first plus more' }]))
  assert.equal(second.items.length, 1)
  assert.equal(second.items[0].id, 'a:m2')
  assert.equal(second.items[0].text, 'first plus more')
  assert.equal(store.items.filter(item => item.id === 'a:m2').length, 1)
})

test('system and injected user messages are not shown as chat bubbles', () => {
  const store = new SessionItemStore('s4')
  store.reset([
    userMessage('m1', 'hello'),
    event('user/message', {
      id: 'ctx',
      role: 'user',
      content: [{ type: 'text', text: 'runtime context' }],
      source: { kind: 'runtime-context' },
    }),
    event('system/message', { turn: 1, step: 1, message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'sys' }], source: { kind: 'system-prompt' } } }),
  ])
  assert.deepEqual(store.items.map(item => item.id), ['u:m1'])
})

test('model selection folds the durable intent and request headers', () => {
  const store = new SessionItemStore('s5')
  store.ingest(event('request/header', { header: { config: { provider: 'p', model: 'flash', reasoningEffort: 'max' } }, reason: 'initial' }))
  assert.deepEqual(store.currentSelection(), { provider: 'p', model: 'flash', reasoningEffort: 'max' })
  store.ingest(event('model/selection', { provider: 'p', model: 'pro' }))
  assert.deepEqual(store.currentSelection(), { provider: 'p', model: 'pro' })
  store.ingest(event('request/header', { header: { config: { provider: 'p', model: 'pro' } }, reason: 'series' }))
  assert.deepEqual(store.currentSelection(), { provider: 'p', model: 'pro' })
})

test('snapshots are bounded and keep the newest items', () => {
  const store = new SessionItemStore('s6')
  const events = []
  for (let index = 0; index < 260; index += 1) events.push(userMessage(`m${index}`, `message ${index}`))
  store.reset(events)
  const snapshot = store.snapshot(200)
  assert.equal(snapshot.length, 200)
  assert.equal(snapshot.at(-1).id, 'u:m259')
})

test('notices use the n:<uuid> id namespace', () => {
  const store = new SessionItemStore('s7')
  const notice = store.addNotice('执行失败：boom')
  assert.match(notice.id, /^n:[0-9a-f-]{36}$/)
  assert.equal(notice.kind, 'notice')
  assert.match(notice.text, /执行失败/)
})
