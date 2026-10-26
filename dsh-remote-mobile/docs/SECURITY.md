# 安全说明

## 1. 威胁模型

| 资产 | 风险 | 本插件的边界 |
|---|---|---|
| DSH Agent | 持有令牌者可让 Agent 执行任意工具（命令、读写文件、联网） | 令牌即完整操作权；默认关闭、默认仅要求鉴权，不做账号体系 |
| 会话内容 | 令牌泄露 → 会话历史/工作区内容泄露 | 令牌不落日志/URL；设置页默认掩码，复制仅本机 |
| Host 进程 | 恶意无限帧/超长帧/Host 崩溃 | 单帧 ≤1MB；端口占用不 crash Host；异常只影响插件 |
| 桌面端审批 | 插件拦截审批后绕过 Host 策略 | 只是 Host `approval/request` waterfall 的 answerer，不修改策略/沙箱；未打开会话继续走桌面端 |
| Web UI 身份 | 手机复用浏览器 cookie | 明确禁止；手机使用独立随机令牌 + 常量时间比较 |

**给用户的明确警告（设置页也显示）**：持有令牌的人可以驱动本机 Agent 执行工具，包括运行命令、
读写文件。请仅在可信局域网使用，切勿公开令牌；停用插件会立即关闭端口并断开手机。

## 2. 令牌

- 首次启用时随机生成：24 字节随机 → base64url ≥32 字符；也可在插件 config 里预置。
- 保存位置：`%DSH_HOME%\dsh-remote-mobile\state.json`（Windows 上按 0600 创建；建议确认该目录
  只有当前用户可读）。不会写入日志、错误信息或 URL。
- 比较：`crypto.timingSafeEqual`（长度不等直接拒绝）。
- 轮换：设置页“更换令牌” → 生成新令牌、持久化、立即以 4401 断开所有旧客户端。
- 复制/配对文本：`POST /dsh-remote-mobile/api/token|pairing` 仅接受 **loopback** 请求，
  且要求同源 + `x-dsh-remote-mobile: 1` 请求头。
- 令牌泄露处置：设置页轮换令牌 → 旧客户端全部断开；检查 `state.json` 与 DSH 日志是否曾被泄露。

## 3. 网络暴露

- 默认 `host: 0.0.0.0`、`port: 8787`：同一局域网设备可尝试连接（仍需令牌）。
- 仅本机使用：设置页把监听地址改为 `127.0.0.1`，配合 SSH 隧道/VPN。
- Windows 防火墙：只对“专用网络”放行端口；不要在公共 Wi-Fi 上开放。

```powershell
New-NetFirewallRule -DisplayName "DSH Remote Mobile" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

- 不要做公网端口映射/中继；本插件非目标包含公网中继与推送。
- 反向代理/TLS 不在本插件范围内；如需要请在可信代理后自行终结 TLS（手机端支持 `wss://`）。

## 4. 审批与权限

- 手机审批仅对“至少一个手机客户端打开过且当前有客户端在线”的会话生效；其余审批 `next()`
  回到 Host 原有 answerer（桌面端弹窗）。
- 审批超时 10 分钟；全部客户端断开 30 秒后取消；重连后重放待审批。
- 审批结果只映射 Host 的 `allowed-once` / `rejected` / `cancelled`，不会产生“永久允许”。
- Host 的有效审批策略（`approval/policy`）与沙箱策略仍然先生效：策略为 `never` 时不会询问
  任何 answerer；工具自身的权限/沙箱校验不受插件影响。

## 5. HTTP 设置 API

- 注册在 Host Web 服务器同源路径 `/dsh-remote-mobile/api/*`；所有变更接口：
  - 拒绝 `sec-fetch-site: cross-site`
  - 有 `Origin` 时必须与 `Host` 一致（桌面端代理会去掉 Origin，此时按同源处理）
  - 要求 `x-dsh-remote-mobile: 1`（阻止简单跨站表单）
  - 令牌明文/配对文本额外要求 loopback
- 响应 `cache-control: no-store`。

## 6. 不做的事

- 不绕过 DSH 权限策略、沙箱、工具自身校验
- 不复用 Web UI cookie
- 不把令牌放进 URL（配对文本除外，且只在本机生成，手机端当前仍是手动输入）
- 不做账号体系、公网中继、推送通知
