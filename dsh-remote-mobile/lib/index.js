/**
 * dsh-remote-mobile — Host half.
 *
 * A default-off Host plugin that runs an authenticated WebSocket gateway for
 * the DSH Remote phone app. It drives the same live Sessions the desktop UI
 * uses (no second agent, no ACP subprocess) and exposes a small same-origin
 * HTTP API for its Settings page.
 *
 * @module @dsh-external/dsh-remote-mobile
 */

import { HostBridge } from './host-bridge.js'
import { MobileGateway } from './gateway.js'
import { StateStore } from './state-store.js'
import {
  VERSION,
  generateToken,
  isWildcardHost,
  maskToken,
  normalizeWsPath,
  optionalString,
} from './protocol.js'

export const name = 'dsh-remote-mobile'

/** Host services this plugin cannot work without. */
export const inject = ['agents', 'sessions', 'sessionController']

const DEFAULT_HOST = '0.0.0.0'
const DEFAULT_PORT = 8787
const DEFAULT_WS_PATH = '/dsh'
const API_PREFIX = '/dsh-remote-mobile/api'

/**
 * Normalize the Loader row config.
 * @param {unknown} raw row config from the bundle patch.
 * @returns {{enabled: boolean, host: string, port: number, path: string, token: string, workspace: string}} resolved config.
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const port = Number(config.port)
  return {
    enabled: config.enabled === true,
    host: typeof config.host === 'string' && config.host.trim() ? config.host.trim() : DEFAULT_HOST,
    port: Number.isSafeInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    path: normalizeWsPath(typeof config.path === 'string' ? config.path : DEFAULT_WS_PATH),
    token: typeof config.token === 'string' ? config.token.trim() : '',
    workspace: typeof config.workspace === 'string' ? config.workspace.trim() : '',
  }
}

/**
 * Mount the gateway.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context.
 * @param {unknown} rawConfig Loader row config.
 */
export function apply(ctx, rawConfig) {
  const log = message => {
    try {
      ctx.logger?.info?.(message)
    } catch {}
  }
  const logError = message => {
    try {
      ctx.logger?.warn?.(message)
    } catch {}
  }

  const bootstrap = resolveConfig(rawConfig)
  const store = new StateStore({ logError })
  store.load()

  const runtime = {
    enabled: store.data.enabled ?? bootstrap.enabled,
    host: store.data.host ?? bootstrap.host,
    port: store.data.port ?? bootstrap.port,
    path: store.data.path ?? bootstrap.path,
  }
  const token = store.resolveToken(bootstrap.token)

  const bridge = new HostBridge({ ctx, config: bootstrap, log, logError })
  const gateway = new MobileGateway({
    bridge,
    config: { host: runtime.host, port: runtime.port, path: runtime.path, token },
    log,
    logError,
  })
  bridge.setGateway(gateway)
  bridge.attach()

  let lastError = ''

  const startGateway = async () => {
    try {
      const started = await gateway.start()
      if (!started) {
        lastError = gateway.lastError
        return false
      }
      lastError = ''
      gateway.broadcast('bridge.status', { online: true, message: '' })
      return true
    } catch (error) {
      lastError = `启动网关失败: ${error instanceof Error ? error.message : String(error)}`
      logError(`[dsh-remote-mobile] ${lastError}`)
      return false
    }
  }

  const stopGateway = async () => {
    try {
      await gateway.stop()
    } catch (error) {
      logError(`[dsh-remote-mobile] 停止网关失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Apply one runtime settings patch, persist it, and restart the listener when needed. */
  const applyRuntimeConfig = async patch => {
    const before = { enabled: runtime.enabled, host: runtime.host, port: runtime.port, path: runtime.path }
    if (patch.enabled !== undefined) runtime.enabled = patch.enabled === true
    if (patch.host !== undefined) {
      const host = String(patch.host).trim()
      if (!host) throw new Error('监听地址不能为空')
      runtime.host = host
    }
    if (patch.port !== undefined) {
      const port = Number(patch.port)
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1-65535 的整数')
      runtime.port = port
    }
    if (patch.path !== undefined) runtime.path = normalizeWsPath(String(patch.path))
    gateway.host = runtime.host
    gateway.port = runtime.port
    gateway.path = runtime.path
    store.update({ enabled: runtime.enabled, host: runtime.host, port: runtime.port, path: runtime.path })
    const listeningConfigChanged = before.host !== runtime.host || before.port !== runtime.port || before.path !== runtime.path
    if (runtime.enabled) {
      if (gateway.listening && listeningConfigChanged) await stopGateway()
      if (!gateway.listening) await startGateway()
    } else if (gateway.listening || listeningConfigChanged) {
      await stopGateway()
    }
    return statePayload()
  }

  const rotateToken = () => {
    const next = generateToken()
    store.update({ token: next })
    gateway.rotateToken(next)
    return next
  }

  /** Flat settings snapshot for the Client half (never includes the raw token). */
  const statePayload = () => {
    const gatewayStatus = gateway.status()
    const host = bridge.info()
    return {
      name: 'dsh-remote-mobile',
      version: VERSION,
      enabled: runtime.enabled,
      listening: gatewayStatus.listening,
      host: gatewayStatus.host,
      port: gatewayStatus.port,
      path: gatewayStatus.path,
      urls: gatewayStatus.urls,
      lanUrl: gatewayStatus.urls[0] ?? '',
      clients: gatewayStatus.clientCount,
      pendingApprovals: gatewayStatus.pendingApprovals,
      lastError: lastError || gatewayStatus.lastError,
      startedAt: gatewayStatus.startedAt,
      tokenMasked: maskToken(token),
      hasToken: token.length > 0,
      hostOnline: host.online,
      hostWarning: host.warning || '',
      defaultCwd: host.defaultCwd,
      workspace: host.workspace,
      agent: host.agent,
      securityWarning:
        '持有访问令牌的人可以驱动本机 Agent 执行工具（包括运行命令、读写文件）。请仅在可信局域网使用，切勿公开令牌；停用开关会立即关闭端口并断开手机。',
      firewallHint: `若手机无法连接，请在系统防火墙中允许 TCP ${gatewayStatus.port} 入站；建议只在本机/私有网络访问该端口。`,
      diagnostics: bridge.debugSnapshot(),
    }
  }

  /** Same-origin / loopback gate for the settings API. */
  const requestTrust = request => {
    const remote = request.socket?.remoteAddress ?? ''
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    const secFetchSite = String(request.headers['sec-fetch-site'] ?? '')
    if (secFetchSite === 'cross-site') return { ok: false, status: 403, error: '拒绝跨站请求' }
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : ''
    if (origin) {
      let originHost = ''
      try {
        originHost = new URL(origin).host
      } catch {
        return { ok: false, status: 403, error: '无效的 Origin' }
      }
      if (originHost !== String(request.headers.host ?? '')) {
        return { ok: false, status: 403, error: 'Origin 与 Host 不一致' }
      }
    }
    return { ok: true, loopback }
  }

  /** Register the settings API routes on the Host web server. */
  const registerHttpApi = webCtx => {
    const webServer = webCtx.get('webServer')
    if (webServer === undefined) return
    const send = (response, statusCode, payload) => {
      try {
        response.writeHead(statusCode, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(JSON.stringify(payload))
      } catch {}
    }
    const guard = (request, response, options = {}) => {
      const trust = requestTrust(request)
      if (!trust.ok) {
        send(response, trust.status, { error: trust.error })
        return false
      }
      if (request.headers['x-dsh-remote-mobile'] !== '1') {
        send(response, 403, { error: '缺少本地设置请求标头' })
        return false
      }
      if (options.loopbackOnly === true && trust.loopback !== true) {
        send(response, 403, { error: '该操作只允许本机页面执行' })
        return false
      }
      return true
    }
    const routes = [
      {
        kind: 'exact',
        path: `${API_PREFIX}/state`,
        handler: (request, response) => {
          if (request.method !== 'GET') {
            send(response, 405, { error: 'method not allowed', allow: 'GET' })
            return
          }
          send(response, 200, statePayload())
        },
      },
      {
        kind: 'exact',
        path: `${API_PREFIX}/update`,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { error: 'method not allowed', allow: 'POST' })
            return
          }
          if (!guard(request, response)) return
          try {
            const body = await readJsonBody(request)
            send(response, 200, await applyRuntimeConfig({
              enabled: body.enabled,
              host: body.host,
              port: body.port,
              path: body.path,
            }))
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error)
            send(response, 400, { error: lastError })
          }
        },
      },
      {
        kind: 'exact',
        path: `${API_PREFIX}/rotate`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { error: 'method not allowed', allow: 'POST' })
            return
          }
          if (!guard(request, response)) return
          rotateToken()
          send(response, 200, statePayload())
        },
      },
      {
        kind: 'exact',
        path: `${API_PREFIX}/token`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { error: 'method not allowed', allow: 'POST' })
            return
          }
          if (!guard(request, response, { loopbackOnly: true })) return
          send(response, 200, { token })
        },
      },
      {
        kind: 'exact',
        path: `${API_PREFIX}/pairing`,
        handler: (request, response) => {
          if (request.method !== 'POST') {
            send(response, 405, { error: 'method not allowed', allow: 'POST' })
            return
          }
          if (!guard(request, response, { loopbackOnly: true })) return
          const url = gateway.urls()[0] ?? ''
          send(response, 200, {
            pairing: url ? `dshremote://pair?url=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}` : '',
          })
        },
      },
    ]
    const disposers = []
    for (const route of routes) {
      try {
        disposers.push(webServer.register(route))
      } catch (error) {
        logError(`[dsh-remote-mobile] could not register ${route.path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    webCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {}
      }
    }, 'dsh-remote-mobile.settings-api')
  }

  if (ctx.get('webServer') !== undefined) {
    registerHttpApi(ctx)
  } else {
    ctx.inject(['webServer'], webCtx => registerHttpApi(webCtx))
  }

  log(`[dsh-remote-mobile] ${VERSION} loaded (enabled=${runtime.enabled}, ws ${runtime.host}:${runtime.port}${runtime.path})`)

  ctx.effect(() => async () => {
    bridge.dispose()
    await stopGateway()
    store.save()
  }, 'dsh-remote-mobile.gateway')

  if (runtime.enabled) {
    void startGateway()
  }
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是 JSON 对象')
  return parsed
}

export { VERSION, generateToken, isWildcardHost, normalizeWsPath, optionalString }
