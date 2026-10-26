/**
 * dsh-remote-mobile — Client half (prebuilt plain-JS Web UI plugin).
 *
 * Registers a Settings page ("远程访问") plus the bundle-config seat for the
 * sidebar Plugins panel. It talks to the Host half through same-origin HTTP
 * routes under /dsh-remote-mobile/api and never imports UI primitives.
 *
 * Format: window.__ModuleLoader__.load({ id, factory }) — id must equal the
 * npm package name.
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-remote-mobile',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'remote-mobile'
    const ROUTE = '/dsh-remote-mobile/api'

    // ---- Host API ----------------------------------------------------------
    const parse = async response => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(body.error || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return body
    }
    const getState = () => fetch(ROUTE + '/state', { cache: 'no-store' }).then(parse)
    const post = (path, body) => fetch(ROUTE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-remote-mobile': '1' },
      body: JSON.stringify(body || {}),
    }).then(parse)

    function useHostState(pollMs) {
      const [snap, setSnap] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let alive = true
        let timer
        const tick = async () => {
          try {
            const data = await getState()
            if (alive) setSnap({ status: 'ready', data })
          } catch (error) {
            if (alive) setSnap(previous => ({ status: 'error', data: previous.data, error: String(error.message || error) }))
          } finally {
            if (alive) timer = setTimeout(tick, pollMs)
          }
        }
        tick()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [pollMs])
      return snap
    }

    // ---- Host-matching controls (theme tokens only) ------------------------
    const S = {
      page: { display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 760 },
      h1: { margin: 0, fontSize: 20, fontWeight: 500, lineHeight: '28px', color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },
      section: { display: 'flex', flexDirection: 'column' },
      sectionTitle: { margin: '0 0 2px', fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, borderBottom: '0.5px solid var(--dsw-alias-border-l2)', padding: '10px 0' },
      label: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', overflowWrap: 'anywhere' },
      warn: { padding: '10px 12px', fontSize: 12, lineHeight: '18px', borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-state-warn-tertiary)', color: 'var(--dsw-alias-label-secondary)' },
      error: { padding: '10px 12px', fontSize: 12, lineHeight: '18px', borderRadius: 'var(--dsw-radius-md)', background: 'var(--dsw-alias-state-error-secondary, var(--dsw-alias-state-warn-tertiary))', color: 'var(--dsw-alias-label-secondary)' },
      input: { height: 30, padding: '0 10px', minWidth: 180, fontSize: 13, borderRadius: 'var(--dsw-radius-md)', border: '0.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', outline: 'none' },
      mono: { fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
      btn: (primary, disabled) => ({
        height: 28,
        padding: '0 10px',
        fontSize: 12.5,
        borderRadius: 'var(--dsw-radius-md)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        border: primary ? 'none' : '0.5px solid var(--dsw-alias-border-l4)',
        background: primary ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-2)',
        color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
      }),
    }

    function Row({ label, hint, children }) {
      return h('div', { style: S.row },
        h('div', null, h('div', { style: S.label }, label), hint ? h('div', { style: S.hint }, hint) : null),
        children)
    }

    function Switch({ checked, onChange, label }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        'aria-label': label,
        onClick: () => onChange(!checked),
        style: {
          width: 36,
          height: 20,
          borderRadius: 10,
          border: 'none',
          cursor: 'pointer',
          position: 'relative',
          flex: 'none',
          background: checked ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-bg-layer-3)',
        },
      }, h('span', {
        style: {
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: 'var(--dsw-alias-label-primary-foreground)',
          transition: 'left .16s',
        },
      }))
    }

    function Btn({ children, onClick, disabled, primary }) {
      return h('button', { type: 'button', onClick, disabled, style: S.btn(primary, disabled) }, children)
    }

    // ---- the page ----------------------------------------------------------
    function SettingsPage({ t, close }) {
      const snap = useHostState(2000)
      const data = snap.data
      const [draft, setDraft] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(undefined)
      const value = draft || (data && { enabled: data.enabled, host: data.host, port: data.port, path: data.path })
      const act = async (operation, message) => {
        setBusy(true)
        setNotice(undefined)
        try {
          const next = await operation()
          setDraft(null)
          setNotice(message || (next && next.notice) || '')
          return next
        } catch (error) {
          setNotice(String(error.message || error))
          return undefined
        } finally {
          setBusy(false)
        }
      }
      const copyText = async text => {
        try {
          await navigator.clipboard.writeText(text)
          setNotice(t('copied'))
        } catch {
          setNotice(t('copyFailed'))
        }
      }
      const copyToken = async () => {
        const result = await act(() => post('/token'))
        if (result && result.token) await copyText(result.token)
      }
      const copyPairing = async () => {
        const result = await act(() => post('/pairing'))
        if (result && result.pairing) await copyText(result.pairing)
      }
      if (!data) {
        return h('div', { style: S.page },
          h('h1', { style: S.h1 }, t('title')),
          h('div', { style: S.hint }, `${t('hostUnavailable')}${snap.error ? `: ${snap.error}` : ''}`))
      }
      const listening = data.listening === true
      return h('div', { style: S.page },
        h('div', null,
          h('h1', { style: S.h1 }, t('title')),
          h('p', { style: S.intro }, t('intro'))),
        h('div', { style: S.warn }, h('strong', null, `${t('securityTitle')}: `), h('span', null, t('securityBody'))),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, t('connectionTitle')),
          h(Row, { label: t('enabled'), hint: listening ? t('listening') : t('stopped') },
            h(Switch, {
              checked: value.enabled === true,
              label: t('enabled'),
              onChange: enabled => act(() => post('/update', { enabled }), enabled ? t('enabledOn') : t('enabledOff')),
            })),
          h(Row, { label: t('host'), hint: t('hostHint') },
            h('input', {
              style: S.input,
              value: value.host,
              disabled: busy,
              onChange: event => setDraft({ ...value, host: event.target.value }),
            })),
          h(Row, { label: t('port'), hint: t('portHint') },
            h('input', {
              style: S.input,
              value: value.port,
              inputMode: 'numeric',
              disabled: busy,
              onChange: event => setDraft({ ...value, port: Number(event.target.value) || 0 }),
            })),
          h(Row, { label: t('path'), hint: t('pathHint') },
            h('input', {
              style: S.input,
              value: value.path,
              disabled: busy,
              onChange: event => setDraft({ ...value, path: event.target.value }),
            })),
          h(Row, { label: t('apply'), hint: t('applyHint') },
            h('span', { style: { display: 'flex', gap: 8 } },
              h(Btn, {
                primary: true,
                disabled: busy || !draft,
                onClick: () => act(() => post('/update', { host: value.host, port: value.port, path: value.path }), t('saved')),
              }, t('save')),
              h(Btn, { disabled: busy || !draft, onClick: () => setDraft(null) }, t('discard'))))),
        h('div', { style: S.section },
          h('div', { style: S.sectionTitle }, t('accessTitle')),
          h(Row, { label: t('lanUrl'), hint: t('lanUrlHint') },
            h('code', { style: S.mono }, (data.urls && data.urls[0]) || t('notRunning'))),
          h(Row, { label: t('token'), hint: t('tokenHint') },
            h('span', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('code', { style: S.mono }, data.tokenMasked || '—'),
              h(Btn, { disabled: busy, onClick: copyToken }, t('copy')),
              h(Btn, { disabled: busy, onClick: copyPairing }, t('pairing')),
              h(Btn, { disabled: busy, onClick: () => act(() => post('/rotate'), t('rotated')) }, t('rotate')))),
          h(Row, { label: t('clients'), hint: t('clientsHint') }, h('span', { style: S.label }, String(data.clients || 0))),
          h(Row, { label: t('pending'), hint: t('pendingHint') }, h('span', { style: S.label }, String(data.pendingApprovals || 0))),
          h(Row, { label: t('lastError'), hint: t('lastErrorHint') },
            h('span', { style: S.hint }, data.lastError || t('none')))),
        h('div', { style: S.hint }, data.firewallHint || ''),
        notice ? h('div', { style: S.hint }, notice) : null,
        snap.error ? h('div', { style: S.error }, snap.error) : null,
        close ? h('div', null, h(Btn, { onClick: close }, t('done'))) : null)
    }

    // ---- locale dictionaries (both zh and en are required) -----------------
    const zh = {
      nav: '远程访问',
      title: '远程访问',
      intro: '让手机端 DSH Remote 通过 WebSocket 连接这台电脑上的 DSH：共用同一批会话、模型与工具审批。',
      hostUnavailable: '宿主端未响应',
      securityTitle: '安全提示',
      securityBody: '持有访问令牌的人可以驱动本机 Agent 执行工具（包括运行命令、读写文件）。请仅在可信局域网使用，切勿公开令牌；停用开关会立即关闭端口并断开手机。',
      connectionTitle: '连接',
      enabled: '启用远程访问',
      enabledHint: '开启后手机可以连接。',
      enabledOn: '已开启',
      enabledOff: '已关闭',
      listening: '正在监听',
      stopped: '未监听',
      host: '监听地址',
      hostHint: '0.0.0.0 供局域网访问；127.0.0.1 仅本机（适合 SSH 隧道）。',
      port: '端口',
      portHint: '默认 8787。',
      path: '路径',
      pathHint: 'WebSocket 挂载路径，默认 /dsh。',
      apply: '应用修改',
      applyHint: '保存监听设置；端口/地址变化会重启网关。',
      save: '保存',
      discard: '放弃',
      saved: '设置已保存',
      accessTitle: '手机连接信息',
      lanUrl: '局域网地址',
      lanUrlHint: '在手机 App 中填写这个 WebSocket 地址。',
      token: '访问令牌',
      tokenHint: '默认掩码显示；复制操作只在本机执行。',
      copy: '复制令牌',
      copied: '令牌已复制',
      copyFailed: '复制失败',
      pairing: '复制配对信息',
      rotate: '更换令牌',
      rotated: '令牌已更换，旧客户端已断开',
      clients: '已连接设备',
      clientsHint: '当前保持连接的手机/平板数量。',
      pending: '待处理审批',
      pendingHint: '正在等待手机响应的工具审批数量。',
      lastError: '最近错误',
      lastErrorHint: '为空表示没有错误。',
      none: '无',
      notRunning: '未运行',
      done: '完成',
    }
    const en = {
      nav: 'Remote Access',
      title: 'Remote Access',
      intro: 'Let the DSH Remote phone app connect to this DSH over WebSocket, sharing the same sessions, models and tool approvals.',
      hostUnavailable: 'The Host half did not answer',
      securityTitle: 'Security notice',
      securityBody: 'Anyone holding the access token can drive this machine’s Agent, including running commands and reading or writing files. Use it only on a trusted LAN, never publish the token, and disable it when done.',
      connectionTitle: 'Connection',
      enabled: 'Enable remote access',
      enabledHint: 'Lets a phone connect.',
      enabledOn: 'Enabled',
      enabledOff: 'Disabled',
      listening: 'Listening',
      stopped: 'Stopped',
      host: 'Listen address',
      hostHint: '0.0.0.0 for LAN access; 127.0.0.1 is local-only (SSH tunnel).',
      port: 'Port',
      portHint: 'Defaults to 8787.',
      path: 'Path',
      pathHint: 'WebSocket mount path, defaults to /dsh.',
      apply: 'Apply changes',
      applyHint: 'Save the listener settings; address/port changes restart the gateway.',
      save: 'Save',
      discard: 'Discard',
      saved: 'Settings saved',
      accessTitle: 'Phone connection details',
      lanUrl: 'LAN URL',
      lanUrlHint: 'Enter this WebSocket URL in the phone app.',
      token: 'Access token',
      tokenHint: 'Masked by default; copying only happens locally.',
      copy: 'Copy token',
      copied: 'Token copied',
      copyFailed: 'Copy failed',
      pairing: 'Copy pairing',
      rotate: 'Rotate token',
      rotated: 'Token rotated; previous clients were disconnected',
      clients: 'Connected clients',
      clientsHint: 'Phones/tablets currently connected.',
      pending: 'Pending approvals',
      pendingHint: 'Tool approvals waiting for a phone response.',
      lastError: 'Last error',
      lastErrorHint: 'Empty means none.',
      none: 'None',
      notRunning: 'Not running',
      done: 'Done',
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote-mobile: dictionaries')
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'remote-mobile',
          order: 45,
          label: () => t('nav'),
          locale: NS,
        }, SettingsPage)), 'dsh-remote-mobile: settings section')
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@dsh-external/dsh-remote-mobile',
          locale: NS,
        }, SettingsPage)), 'dsh-remote-mobile: bundle config page')
      },
    }
  },
})
