/**
 * Protocol helper tests (frozen phone contract helpers).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  APPROVAL_OPTIONS,
  MAX_PREVIEW,
  RpcError,
  generateToken,
  helloPayload,
  invalidParams,
  maskToken,
  normalizeWsPath,
  previewText,
  requireString,
  safeEqual,
  titleFromPrompt,
  toolLabel,
} from '../lib/protocol.js'

test('ws path normalization matches the phone default', () => {
  assert.equal(normalizeWsPath(''), '/dsh')
  assert.equal(normalizeWsPath('dsh'), '/dsh')
  assert.equal(normalizeWsPath('/dsh/'), '/dsh')
  assert.equal(normalizeWsPath('/mobile/'), '/mobile')
  assert.equal(normalizeWsPath('/'), '/')
})

test('token comparison and masking stay constant-time and non-revealing', () => {
  assert.equal(safeEqual('abc', 'abc'), true)
  assert.equal(safeEqual('abc', 'abd'), false)
  assert.equal(safeEqual('abc', 'abcd'), false)
  const token = generateToken()
  assert.ok(token.length >= 32)
  assert.notEqual(generateToken(), generateToken())
  const masked = maskToken(token)
  assert.ok(masked.endsWith(token.slice(-4)))
  assert.ok(!masked.includes(token.slice(0, 10)))
})

test('approval options are exactly the frozen phone vocabulary', () => {
  assert.deepEqual(APPROVAL_OPTIONS, [
    { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
    { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' },
  ])
})

test('tool labels map the common Host tool names', () => {
  assert.equal(toolLabel('pwsh'), '终端命令')
  assert.equal(toolLabel('read_file'), '读取文件')
  assert.equal(toolLabel('str_replace_editor'), '编辑文件')
  assert.equal(toolLabel('web_search'), '联网搜索')
  assert.equal(toolLabel('mcp__github__issue'), 'MCP 工具')
  assert.equal(toolLabel('unknown_tool'), '工具调用')
})

test('preview strips code fences and truncates without breaking the contract', () => {
  const preview = previewText('看看这个\n```js\nconst a = 1\n```\n然后回答', MAX_PREVIEW)
  assert.ok(preview.length <= MAX_PREVIEW + 1)
  assert.ok(preview.includes('[代码]'))
  const long = previewText('x'.repeat(200), 20)
  assert.equal(long.length, 21)
  assert.ok(long.endsWith('…'))
})

test('titles come from the first non-empty prompt line', () => {
  assert.equal(titleFromPrompt('\n\n 帮我修一下构建 '), '帮我修一下构建')
  assert.equal(titleFromPrompt(''), '新会话')
  assert.ok(titleFromPrompt('y'.repeat(80)).length <= 49)
})

test('required string params produce -32602', () => {
  assert.throws(() => requireString({}, 'sessionId'), error => error instanceof RpcError && error.code === -32602)
  assert.equal(requireString({ sessionId: 's' }, 'sessionId'), 's')
  assert.equal(invalidParams('x').code, -32602)
})

test('hello payload mirrors the frozen server.info shape', () => {
  const hello = helloPayload({
    path: '/dsh',
    workspace: 'C:\\ws',
    defaultCwd: 'C:\\ws',
    online: true,
    agent: { name: 'deepseek-harness', version: '1.2.3' },
    capabilities: { approvals: true },
  })
  assert.deepEqual(hello, {
    name: 'dsh-remote-mobile',
    version: '0.1.0',
    path: '/dsh',
    workspace: 'C:\\ws',
    defaultCwd: 'C:\\ws',
    online: true,
    agent: { name: 'deepseek-harness', version: '1.2.3' },
    capabilities: { approvals: true },
  })
})
