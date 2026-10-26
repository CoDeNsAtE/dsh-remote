# 安装与配置

## 1. 前置条件

- DSH 版本：0.2.1-rc.3（`desktop` / `web` profile 均可；插件按 DSH 0.2.x 的 Host 服务实现）。
- Node.js ≥ 20（插件 vendored `ws`，安装时不需要为它额外拉取运行时依赖）。
- 手机与电脑同一局域网；或使用 SSH 隧道/VPN。
- 本机端口 8787（或你选择的端口）空闲。

> 本仓库是 HarmonyOS App 工程，插件位于 `dsh-remote-mobile/` 子目录，安装时填该目录的**绝对路径**。

## 2. 选择 profile

| 你日常使用的 DSH | 安装 profile | 说明 |
|---|---|---|
| 桌面端 DeepSeek Harness | `desktop` | 与桌面端 UI 共用会话/插件/技能/MCP（本仓库验证所用） |
| `dsh web` | `web` | 与 `dsh web` 共用 |

只安装到一个 profile。两个 profile 同时启用同一端口会端口冲突（插件会显示错误，不影响 Host）。

## 3. 安装 bundle

### 3.1 DSH GUI（推荐）

Settings → Plugins → 从本地目录安装：

```
<仓库绝对路径>\dsh-remote-mobile
```

### 3.2 Agent / plugin manager

```text
plugin_manager(action="install_bundle", target="<仓库绝对路径>\\dsh-remote-mobile")
```

安装会完成：pnpm 安装（本地目录被 link）、`dsh.profile.bundles` 选择、Loader patch 插入、
HMR 激活。新 bundle 一般无需重启；**替换**已安装的同名包需要重启 Host 才能加载新的 Host 代码。

### 3.3 DSH CLI

```powershell
dsh plugin --profile desktop add "<仓库绝对路径>\dsh-remote-mobile"
dsh plugin --profile desktop enable @dsh-external/dsh-remote-mobile
```

（把 `desktop` 换成 `web` 即可安装到 web profile。）

## 4. 启用

默认 `enabled: false`，安装后不会监听端口。

1. Settings → **远程访问**。
2. 打开“启用远程访问”。
3. 记下“局域网地址”（如 `ws://192.168.1.10:8787/dsh`）。
4. 点“复制令牌”，在手机 App 里粘贴。

也可以直接调用 HTTP API（本机）：

```powershell
$h = @{ 'x-dsh-remote-mobile' = '1'; 'content-type' = 'application/json' }
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:13734/dsh-remote-mobile/api/update' `
  -Headers $h -Body '{"enabled":true}'
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:13734/dsh-remote-mobile/api/token' -Headers $h -Body '{}'
```

（13734 是 DSH Web UI 的端口；以实际为准。令牌会写入 `%DSH_HOME%\dsh-remote-mobile\state.json`。）

## 5. 验证

```powershell
# 网关健康检查
Invoke-WebRequest http://127.0.0.1:8787/health

# 设置 API
Invoke-RestMethod http://127.0.0.1:13734/dsh-remote-mobile/api/state
```

预期：`enabled: true`、`listening: true`、`urls` 含局域网地址、`tokenMasked` 非空、
`clients: 0`、`lastError: ""`。

手机端：填入 URL + 令牌 → 显示“已连接” → 会话列表出现桌面端会话。

## 6. 防火墙

Windows 第一次监听会弹防火墙对话框，允许“专用网络”。未弹窗时：

```powershell
New-NetFirewallRule -DisplayName "DSH Remote Mobile" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

局域网仍连不上时依次检查：

1. `Invoke-RestMethod http://127.0.0.1:13734/dsh-remote-mobile/api/state` 的 `listening`/`urls`；
2. 手机与电脑是否同网段、是否被 AP 隔离；
3. 防火墙入站规则、公司网络策略；
4. 是否填成了桌面端 Web UI 地址而不是 WebSocket 地址（必须 `ws://...:8787/dsh`）。

## 7. 升级 / 修改代码

- 只改 **Client 半**（`client/client.js`）：保存后页面 HMR 或刷新页面即可。
- 改 **Host 半**（`lib/*`）：需要卸载重装或重启 DSH Host，让 Node 重新加载模块：

  ```powershell
  dsh plugin --profile desktop remove @dsh-external/dsh-remote-mobile
  dsh plugin --profile desktop add "<仓库绝对路径>\dsh-remote-mobile"
  ```

  重启后运行时状态（启停/令牌）仍在 `state.json`。

## 8. 卸载

```powershell
dsh plugin --profile desktop remove @dsh-external/dsh-remote-mobile
```

或 Settings → Plugins 移除。卸载会停止网关并移除 Loader 行；`state.json` 可手动删除
（`%DSH_HOME%\dsh-remote-mobile\`）。

## 9. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 设置页显示“端口 8787 已被占用” | 旧 bridge/其他程序占用 | 停掉旧进程，或设置页换端口 |
| 设置页不存在 | 插件未激活 / 页面未刷新 | Settings → Plugins 确认已启用；刷新页面；查看 Host 日志 |
| 手机提示令牌不正确 | 令牌已轮换或复制不完整 | 重新“复制令牌”（自动复制）后粘贴 |
| 手机显示“DSH 离线” | Host 服务异常/插件被禁用 | 看设置页“最近错误”；重新启用插件 |
| 手机能连但列表为空 | profile 里确实没有根会话，或 Host 列表失败 | 桌面端新建会话后再刷新；看 `warning` |
| 手机发 prompt 报“该会话正在执行” | 同会话已有 in-flight prompt | 等待结束或点停止（cancel） |
| 审批不弹到手机 | 会话不是手机打开的，或没有在线客户端，或 Host 策略为 never | 先在手机打开该会话；确认客户端在线；检查 Host 审批策略 |
| 端口改了但手机旧地址连不上 | 运行时端口变更已持久化 | 用设置页的新 URL 重新填写 |
