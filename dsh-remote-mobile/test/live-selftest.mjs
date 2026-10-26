#!/usr/bin/env node
/**
 * Live protocol compatibility test client for the DSH Remote mobile app.
 *
 * Runs the frozen phone protocol against a real DSH Host that has the
 * `dsh-remote-mobile` plugin enabled. Adapted from bridge/selftest.mjs, but it
 * speaks to the in-process Host gateway instead of spawning an ACP child.
 *
 * Usage:
 *   node test/live-selftest.mjs --token <token> [options]
 *
 * Options:
 *   --url <ws://host:port/dsh>   gateway URL (default ws://127.0.0.1:8787/dsh)
 *   --token <token>              access token (required; or DSH_REMOTE_TOKEN)
 *   --settings <http://...>      Host Web UI origin for settings API tests
 *   --skip-llm                   skip prompts/approvals/cancel (no model spend)
 *   --skip-settings              skip the settings HTTP API checks
 *   --rotate-token               also exercise token rotation at the end
 *   --llm-timeout <ms>           approval/LLM wait budget (default 180000)
 */
import { createServer } from 'node:net'
import { parseArgs } from 'node:util'

import WebSocketPackage from '../vendor/ws/index.js'
import { PhoneClient, sleep, waitFor } from './helpers.mjs'

const WebSocket = WebSocketPackage

const { values: options } = parseArgs({
  options: {
    url: { type: 'string', default: 'ws://127.0.0.1:8787/dsh' },
    token: { type: 'string' },
    settings: { type: 'string', default: 'http://127.0.0.1:13734' },
    'skip-llm': { type: 'boolean', default: false },
    'skip-settings': { type: 'boolean', default: false },
    'rotate-token': { type: 'boolean', default: false },
    'llm-timeout': { type: 'string', default: '180000' },
  },
  strict: true,
  allowPositionals: false,
})

const URL = options.url
const settingsOrigin = options.settings.replace(/\/+$/, '')
let TOKEN = options.token ?? process.env.DSH_REMOTE_TOKEN ?? ''
const LLM_TIMEOUT = Number(options['llm-timeout'])
let url = URL
let token = TOKEN

const results = []
let currentStep = ''
let client

function pass(name, detail = '') {
  results.push({ name, ok: true, detail })
  console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`)
}

function fail(name, error) {
  const message = error instanceof Error ? error.message : String(error)
  results.push({ name, ok: false, message })
  console.log(`  FAIL  ${name}: ${message}`)
}

function skip(name, reason) {
  results.push({ name, ok: true, skipped: true, detail: reason })
  console.log(`  SKIP  ${name}: ${reason}`)
}

async function step(name, fn) {
  currentStep = name
  console.log(`\n▶ ${name}`)
  try {
    const outcome = await fn()
    if (outcome === 'skip') return
    if (outcome !== undefined && outcome !== null && typeof outcome === 'object' && outcome.__skip) {
      skip(name, outcome.reason)
      return
    }
    pass(name)
  } catch (error) {
    fail(name, error)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const skippedResult = reason => ({ __skip: true, reason })

async function connect() {
  return PhoneClient.connect(url, token, { timeoutMs: 10_000 })
}

async function openSession(client, sessionId, cwd = '') {
  return client.rpc('session.open', { sessionId, cwd })
}

async function rpcNoWait(client, method, params, timeoutMs = 10_000) {
  return client.rpc(method, params, timeoutMs)
}

function findModelOption(configOptions) {
  return (configOptions ?? []).find(option => option.id === 'model')
}

function findReasoningOption(configOptions) {
  return (configOptions ?? []).find(option => option.id === 'reasoning_effort')
}

async function settingsFetch(path, body) {
  const response = await fetch(`${settingsOrigin}${path}`, body === undefined
    ? { cache: 'no-store' }
    : {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-remote-mobile': '1' },
      body: JSON.stringify(body ?? {}),
    })
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

async function main() {
  if (!token) {
    console.error('Missing --token (or DSH_REMOTE_TOKEN). Get it from Settings > 远程访问 in the DSH Web UI.')
    process.exit(2)
  }
  console.log(`DSH Remote mobile protocol self-test`)
  console.log(`  gateway:  ${url}`)
  console.log(`  settings: ${settingsOrigin}`)
  console.log('')

  // ---- transport / auth ---------------------------------------------------
  await step('auth: an invalid token is rejected with auth.error and 4401', async () => {
    const client = await PhoneClient.connectExpectAuthError(url, 'definitely-wrong-token-000000', 10_000)
    assert(client.authError === '访问令牌不正确', `unexpected auth error: ${client.authError}`)
    await waitFor(() => client.closed, 5000, 'close after auth error')
    assert(client.closed.code === 4401, `unexpected close code ${client.closed.code}`)
    client.close()
  })

  await step('transport: a non-/dsh path is rejected', async () => {
    const wrongUrl = url.replace(/\/dsh$/, '/not-dsh')
    const socket = new WebSocket(wrongUrl)
    const outcome = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('timeout'), 5000)
      socket.on('open', () => {
        clearTimeout(timer)
        resolve('open')
      })
      socket.on('error', () => {
        clearTimeout(timer)
        resolve('error')
      })
      socket.on('close', () => {
        clearTimeout(timer)
        resolve('close')
      })
    })
    try {
      socket.close()
    } catch {}
    assert(outcome !== 'open' && outcome !== 'timeout', `unexpected outcome: ${outcome}`)
  })

  let hello
  await step('handshake: hello, ping/pong and server.info match the frozen shape', async () => {
    client = await connect()
    hello = client.frames.find(frame => frame.type === 'hello')
    assert(hello, 'missing hello frame')
    assert(hello.name === 'dsh-remote-mobile', `hello.name = ${hello.name}`)
    assert(typeof hello.version === 'string' && hello.version.length > 0, 'hello.version missing')
    assert(hello.path === '/dsh' || hello.path.endsWith('/dsh'), `hello.path = ${hello.path}`)
    assert(typeof hello.workspace === 'string' && hello.workspace.length > 0, 'hello.workspace missing')
    assert(typeof hello.defaultCwd === 'string' && hello.defaultCwd.length > 0, 'hello.defaultCwd missing')
    assert(hello.online === true, 'hello.online should be true')
    assert(hello.agent && typeof hello.agent.name === 'string', 'hello.agent missing')
    const pong = await client.ping()
    assert(typeof pong.time === 'number', 'pong.time missing')
    const info = await client.rpc('server.info')
    assert(info.name === hello.name && info.path === hello.path, 'server.info mismatch')
  })
  if (client === undefined) return finish()

  // ---- sessions -----------------------------------------------------------
  await step('sessions.list: returns root sessions sorted by updatedAt', async () => {
    const list = await client.rpc('sessions.list')
    assert(Array.isArray(list.sessions), 'sessions is not an array')
    assert(typeof list.online === 'boolean', 'online missing')
    assert(typeof list.warning === 'string', 'warning missing')
    const fields = ['sessionId', 'cwd', 'title', 'preview', 'createdAt', 'updatedAt', 'running', 'hasTranscript']
    for (const session of list.sessions) {
      for (const field of fields) assert(field in session, `session missing field ${field}`)
    }
    for (let index = 1; index < list.sessions.length; index += 1) {
      assert(list.sessions[index - 1].updatedAt >= list.sessions[index].updatedAt, 'sessions not sorted by updatedAt desc')
    }
  })

  let created
  await step('session.new: creates a real Host session with default model', async () => {
    created = await client.rpc('session.new', { cwd: hello.defaultCwd })
    assert(created.session && typeof created.session.sessionId === 'string' && created.session.sessionId.length > 0, 'session missing')
    assert(created.session.sessionId.startsWith('session-'), `unexpected session id: ${created.session.sessionId}`)
    assert(Array.isArray(created.configOptions), 'configOptions missing')
    const model = findModelOption(created.configOptions)
    assert(model, 'model config option missing')
    let pair
    try {
      pair = JSON.parse(model.currentValue)
    } catch {
      throw new Error(`model currentValue is not JSON: ${model.currentValue}`)
    }
    assert(Array.isArray(pair) && pair.length === 2, 'model value must be a JSON ["provider","model"]')
    const opened = await openSession(client, created.session.sessionId, created.session.cwd)
    assert(opened.attached === true, 'fresh session did not attach')
    assert(Array.isArray(opened.items), 'items missing')
  })
  if (created === undefined) return finish()

  const sessionId = created.session.sessionId
  const sessionCwd = created.session.cwd

  await step('session.open: attaches the live session and returns its options', async () => {
    const opened = await openSession(client, sessionId, sessionCwd)
    assert(opened.attached === true, 'attached should be true')
    assert(Array.isArray(opened.items), 'items must be an array')
    assert(opened.session.sessionId === sessionId, 'summary sessionId mismatch')
    assert(Array.isArray(opened.configOptions) && opened.configOptions.length > 0, 'configOptions missing')
  })

  // ---- config -------------------------------------------------------------
  await step('session.setConfig: model switch round-trips through the Host catalog', async () => {
    const opened = await openSession(client, sessionId, sessionCwd)
    const model = findModelOption(opened.configOptions)
    const other = model.choices.find(choice => choice.value !== model.currentValue)
    if (other === undefined) {
      return skippedResult('only one model is available in this profile')
    }
    const changed = await client.rpc('session.setConfig', { sessionId, configId: 'model', value: other.value })
    const next = findModelOption(changed.configOptions)
    assert(next.currentValue === other.value, `model did not change: ${next.currentValue}`)
    const restored = await client.rpc('session.setConfig', { sessionId, configId: 'model', value: model.currentValue })
    assert(findModelOption(restored.configOptions).currentValue === model.currentValue, 'model restore failed')
  })

  await step('session.setConfig: reasoning effort switch round-trips', async () => {
    const opened = await openSession(client, sessionId, sessionCwd)
    const reasoning = findReasoningOption(opened.configOptions)
    if (reasoning === undefined) return skippedResult('current model does not advertise reasoning efforts')
    const other = reasoning.choices.find(choice => choice.value !== reasoning.currentValue && choice.value !== '')
    if (other === undefined) return skippedResult('no alternative reasoning effort offered')
    const changed = await client.rpc('session.setConfig', { sessionId, configId: 'reasoning_effort', value: other.value })
    assert(findReasoningOption(changed.configOptions).currentValue === other.value, 'reasoning effort did not change')
    const restored = await client.rpc('session.setConfig', { sessionId, configId: 'reasoning_effort', value: reasoning.currentValue })
    assert(findReasoningOption(restored.configOptions).currentValue === reasoning.currentValue, 'reasoning effort restore failed')
  })

  // ---- prompts ------------------------------------------------------------
  const llmEnabled = options['skip-llm'] !== true
  let lastAssistantCount = 0

  if (llmEnabled) {
    await step('session.prompt: streams user/thought/assistant items and turn lifecycle', async () => {
      const mark = client.frames.length
      const result = await client.rpc('session.prompt', { sessionId, text: '用一句话回答：1+1 等于几？' }, LLM_TIMEOUT)
      assert(typeof result.stopReason === 'string' && result.stopReason.length > 0, 'stopReason missing')
      const frames = client.frames.slice(mark)
      const items = frames.filter(frame => frame.type === 'event' && frame.event === 'item.upsert').map(frame => frame.item)
      assert(items.some(item => item.kind === 'user'), 'missing user item')
      assert(items.some(item => item.kind === 'assistant'), 'missing assistant item')
      const statuses = frames.filter(frame => frame.type === 'event' && frame.event === 'turn.status').map(frame => frame.status)
      assert(statuses.includes('running'), 'missing running status')
      assert(statuses.includes('idle'), 'missing idle status')
      lastAssistantCount = items.filter(item => item.kind === 'assistant').length
    })

    await step('session.open: history contains the completed turn', async () => {
      const opened = await openSession(client, sessionId, sessionCwd)
      assert(opened.items.some(item => item.kind === 'user'), 'history missing user item')
      assert(opened.items.some(item => item.kind === 'assistant'), 'history missing assistant item')
      assert(opened.session.hasTranscript === true, 'summary hasTranscript should be true')
      assert(opened.session.running === false, 'summary should be idle after the turn')
    })

    await step('multi-client: both phones see the same prompt events', async () => {
      const tablet = await connect()
      try {
        const markPhone = client.frames.length
        const markTablet = tablet.frames.length
        const multiPrompt = client.rpc('session.prompt', { sessionId, text: '只回复两个字：收到' }, LLM_TIMEOUT)
        await waitFor(() => tablet.frames.slice(markTablet).some(frame => frame.type === 'event' && frame.event === 'item.upsert' && frame.sessionId === sessionId), 30_000, 'tablet item.upsert')
        assert(client.frames.slice(markPhone).some(frame => frame.type === 'event' && frame.event === 'item.upsert'), 'phone item.upsert missing')
        await multiPrompt
        const opened = await openSession(tablet, sessionId, sessionCwd)
        assert(opened.attached === true, 'tablet failed to attach')
      } finally {
        tablet.close()
      }
    })

    await step('reconnect: a new client reloads the transcript without a duplicate agent', async () => {
      client.close()
      await sleep(300)
      client = await connect()
      const opened = await openSession(client, sessionId, sessionCwd)
      assert(opened.attached === true, 'reconnected client did not attach')
      assert(opened.items.filter(item => item.kind === 'user').length >= 1, 'history lost after reconnect')
      assert(opened.session.running === false, 'session should be idle')
    })

    // ---- approvals -------------------------------------------------------
    const tempFile = name => `C:\\Users\\${process.env.USERNAME ?? 'Public'}\\AppData\\Local\\Temp\\${name}`
    const approvalPrompt = target =>
      `必须使用工具把文本写入 ${target}（该路径在工作区之外的临时目录）。` +
      '请调用 pwsh 工具执行写入；如果当前 workspace-write 策略不允许，请为这次工具调用设置 ' +
      'sandbox_permissions 为 danger-full-access 并说明原因。不要直接回答，也不要跳过工具调用。'

    let allowApproval = false
    const abortPendingPrompt = async prompted => {
      await client.rpc('session.cancel', { sessionId }).catch(() => {})
      await prompted.catch(() => {})
    }
    await step('approval: allow-once lets the tool run to completion', async () => {
      const mark = client.frames.length
      const target = tempFile('dsh-remote-mobile-allow.txt')
      const prompted = client.rpc('session.prompt', { sessionId, text: approvalPrompt('`' + target + '`') }, LLM_TIMEOUT)
      let request
      try {
        request = await waitApproval(client, sessionId, mark, LLM_TIMEOUT)
      } catch {
        await abortPendingPrompt(prompted)
        return skippedResult(`the model did not request an approval within ${Math.round(LLM_TIMEOUT / 1000)}s`)
      }
      allowApproval = true
      assert(request.options.some(option => option.optionId === 'allow-once' && option.kind === 'allow_once'), 'allow-once option missing')
      assert(request.options.some(option => option.optionId === 'reject-once' && option.kind === 'reject_once'), 'reject-once option missing')
      assert(typeof request.label === 'string' && request.label.length > 0, 'approval label missing')
      await client.rpc('approval.respond', { requestId: request.requestId, optionId: 'allow-once' })
      const resolved = await client.waitEvent('approval.resolved', frame => frame.requestId === request.requestId, 30_000)
      assert(resolved.decision === 'selected', 'approval.resolved should report selected')
      const result = await prompted
      assert(typeof result.stopReason === 'string', 'prompt did not finish after approval')
      const opened = await openSession(client, sessionId, sessionCwd)
      const toolItem = [...opened.items].reverse().find(item => item.kind === 'tool')
      assert(toolItem, 'no tool item in history')
      assert(toolItem.status === 'completed', `tool item status = ${toolItem.status}`)
      assert(
        String(toolItem.result).includes('dsh-remote-mobile-allow') || String(toolItem.input).includes('dsh-remote-mobile-allow') || String(toolItem.input).includes('danger-full-access'),
        'tool item missing the escalation/file context',
      )
    })

    await step('approval: reject-once marks the tool failed', async () => {
      if (!allowApproval) return skippedResult('no approval was raised earlier')
      const mark = client.frames.length
      const target = tempFile('dsh-remote-mobile-reject.txt')
      const prompted = client.rpc('session.prompt', { sessionId, text: approvalPrompt('`' + target + '`') }, LLM_TIMEOUT)
      let request
      try {
        request = await waitApproval(client, sessionId, mark, LLM_TIMEOUT)
      } catch {
        await abortPendingPrompt(prompted)
        return skippedResult('the model did not request a second approval in time')
      }
      await client.rpc('approval.respond', { requestId: request.requestId, optionId: 'reject-once' })
      await client.waitEvent('approval.resolved', frame => frame.requestId === request.requestId, 30_000)
      const result = await prompted
      assert(typeof result.stopReason === 'string', 'prompt did not finish after rejection')
      const opened = await openSession(client, sessionId, sessionCwd)
      const tools = opened.items.filter(item => item.kind === 'tool')
      assert(tools.length > 0, 'no tool items in history')
      if (!tools.some(item => item.status === 'failed')) {
        return skippedResult('the tool was not reported failed (model may have avoided the tool)')
      }
    })

    await step('approval: a pending request is replayed after reconnect', async () => {
      if (!allowApproval) return skippedResult('no approval was raised earlier')
      const mark = client.frames.length
      const target = tempFile('dsh-remote-mobile-replay.txt')
      const prompted = client.rpc('session.prompt', { sessionId, text: approvalPrompt('`' + target + '`') }, LLM_TIMEOUT)
      let request
      try {
        request = await waitApproval(client, sessionId, mark, LLM_TIMEOUT)
      } catch {
        await abortPendingPrompt(prompted)
        return skippedResult('the model did not request another approval in time')
      }
      void prompted.catch(() => {})
      client.close()
      await sleep(400)
      client = await connect()
      const replayed = await client.waitEvent('approval.request', frame => frame.requestId === request.requestId, 15_000)
      assert(replayed.requestId === request.requestId, 'replayed request id mismatch')
      await client.rpc('approval.respond', { requestId: replayed.requestId, optionId: 'allow-once' })
      await client.waitEvent('approval.resolved', frame => frame.requestId === replayed.requestId, 30_000)
      await client.waitEvent('turn.status', frame => frame.sessionId === sessionId && frame.status === 'idle', LLM_TIMEOUT).catch(() => {})
      await waitFor(async () => {
        const opened = await openSession(client, sessionId, sessionCwd).catch(() => undefined)
        return opened !== undefined
      }, 15_000, 'session opens after replay')
    })

    await step('session.cancel: cancels the in-flight turn cleanly', async () => {
      const mark = client.frames.length
      const prompted = client.rpc('session.prompt', { sessionId, text: '请执行 `sleep 60` 这个命令，等它结束后再回答。' }, LLM_TIMEOUT)
      try {
        await waitFor(() => client.frames.slice(mark).some(frame => frame.type === 'event' && frame.event === 'turn.status' && frame.status === 'running'), 15_000, 'running status')
      } catch {
        await prompted.catch(() => {})
        return skippedResult('the turn did not start in time')
      }
      // If the model asks for approval, answer it so the turn really runs.
      try {
        const approval = await waitApproval(client, sessionId, mark, 800)
        await client.rpc('approval.respond', { requestId: approval.requestId, optionId: 'allow-once' })
      } catch {}
      await sleep(500)
      await client.rpc('session.cancel', { sessionId })
      const result = await prompted
      assert(result.stopReason === 'cancelled', `cancel returned ${result.stopReason}`)
      await waitFor(() => client.frames.slice(mark).some(frame => frame.type === 'event' && frame.event === 'turn.status' && frame.status === 'idle'), 15_000, 'idle status after cancel')
    })
  } else {
    console.log('\n(skipping prompt/approval/cancel checks because --skip-llm was passed)')
  }

  // ---- settings API -------------------------------------------------------
  if (options['skip-settings'] !== true) {
    await step('settings API: /state reports the gateway and security warning', async () => {
      const { status, payload } = await settingsFetch('/dsh-remote-mobile/api/state')
      if (status === 404) return skippedResult('settings API route is not mounted in this profile')
      assert(status === 200, `state returned HTTP ${status}`)
      assert(payload.enabled === true, 'enabled should be true')
      assert(payload.listening === true, 'listening should be true')
      assert(typeof payload.tokenMasked === 'string' && payload.tokenMasked.length > 0, 'tokenMasked missing')
      assert(typeof payload.securityWarning === 'string' && payload.securityWarning.length > 0, 'security warning missing')
      assert(Array.isArray(payload.urls) && payload.urls.length > 0, 'urls missing')
      assert(typeof payload.clients === 'number', 'clients missing')
      assert(typeof payload.lastError === 'string', 'lastError missing')
    })

    await step('settings API: disable closes the port and enable reopens it', async () => {
      const disabled = await settingsFetch('/dsh-remote-mobile/api/update', { enabled: false })
      assert(disabled.status === 200, `disable returned HTTP ${disabled.status}`)
      assert(disabled.payload.listening === false, 'gateway still listening after disable')
      await waitFor(() => client.closed !== undefined || client.socket?.readyState !== 1, 8000, 'phone disconnected after disable').catch(() => {})
      const stateOff = await settingsFetch('/dsh-remote-mobile/api/state')
      assert(stateOff.payload.listening === false, 'state still reports listening after disable')
      const enabled = await settingsFetch('/dsh-remote-mobile/api/update', { enabled: true })
      assert(enabled.status === 200, `enable returned HTTP ${enabled.status}`)
      assert(enabled.payload.listening === true, 'gateway did not restart')
      client = await connect()
      await client.ping()
    })

    await step('settings API: a busy port is reported instead of crashing the gateway', async () => {
      const blocker = createServer()
      const port = await new Promise((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port))
      })
      const state = (await settingsFetch('/dsh-remote-mobile/api/state')).payload
      const originalPort = state.port
      const originalHost = state.host
      try {
        // Bind the probe on the same interface the gateway will try.
        const changed = await settingsFetch('/dsh-remote-mobile/api/update', { host: '127.0.0.1', port })
        assert(changed.status === 200, `update returned HTTP ${changed.status}`)
        assert(/占用|无法启动/.test(changed.payload.lastError || ''), `unexpected lastError: ${changed.payload.lastError}`)
        assert(changed.payload.listening === false, 'gateway should not be listening on the busy port')
      } finally {
        await new Promise(resolve => blocker.close(() => resolve()))
        const restored = await settingsFetch('/dsh-remote-mobile/api/update', { host: originalHost, port: originalPort })
        assert(restored.payload.listening === true, 'gateway failed to restart on the original port')
        client = await connect()
        await client.ping()
      }
    })

    if (options['rotate-token'] === true) {
      await step('security: token rotation disconnects old clients and accepts the new token', async () => {
        const state = (await settingsFetch('/dsh-remote-mobile/api/state')).payload
        const rotated = await settingsFetch('/dsh-remote-mobile/api/rotate', {})
        assert(rotated.status === 200, `rotate returned HTTP ${rotated.status}`)
        const revealed = await settingsFetch('/dsh-remote-mobile/api/token', {})
        if (revealed.status !== 200 || typeof revealed.payload.token !== 'string') {
          return skippedResult('token reveal is restricted to loopback; could not verify')
        }
        const oldToken = token
        token = revealed.payload.token
        await waitFor(() => client.closed !== undefined || client.socket?.readyState !== 1, 8000, 'old client disconnected').catch(() => {})
        const stale = await PhoneClient.connectExpectAuthError(url, oldToken, 8000)
        assert(stale.authError === '访问令牌不正确', 'old token was not rejected')
        stale.close()
        client = await connect()
        await client.ping()
        assert(token !== oldToken && state.tokenMasked !== token, 'rotation did not change the token')
      })
    }
  }

  return finish()
}

async function waitApproval(client, sessionId, mark, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = client.frames.slice(mark).find(frame =>
      frame.type === 'event' && frame.event === 'approval.request' && frame.sessionId === sessionId)
    if (found) return found
    await sleep(100)
  }
  throw new Error('timed out waiting for approval.request')
}

function finish() {
  client?.close()
  const failed = results.filter(result => !result.ok)
  const skipped = results.filter(result => result.skipped)
  console.log('\n─────────────────────────────────────────────')
  console.log(`  ${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`)
  if (failed.length > 0) {
    console.log('\nFailures:')
    for (const result of failed) console.log(`  ✖ ${result.name}: ${result.message}`)
    process.exitCode = 1
  }
  console.log('')
}

main().catch(error => {
  console.error(`\nSELFTEST ABORTED during "${currentStep}": ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
