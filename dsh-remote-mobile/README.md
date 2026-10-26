# dsh-remote-mobile

DSH（DeepSeek Harness）手机远程控制网关插件。它在 **DSH Host 进程内**启动一个带令牌鉴权的
WebSocket 服务，让已经开发好的 HarmonyOS 应用 **DSH Remote** 直接连到用户日常使用的 DSH：

- 会话列表 / 新建 / 打开 / 恢复历史（与桌面端同一批真实会话）
- 文本 prompt、流式事件、取消（驱动同一个 live Agent，不另起 ACP 子进程）
- 模型与 reasoning effort 切换（走 Host 的 LLM catalog 与 model-selection seam）
- 工具审批转发到手机（只拦截手机打开过的会话，仍受 Host 权限策略/沙箱约束）
- 多客户端广播、断线重连、审批重放、令牌轮换
- 一个真实可用的 DSH 设置页（Settings → 远程访问），可启停、改地址/端口、复制/轮换令牌、查看连接数与最近错误

手机 App **零改动**：协议与旧的外部 `bridge/dsh-mobile-bridge.mjs` 完全一致。

---

## 1. 安装

本插件是一个 **bundle 插件**，安装进当前 DSH profile（默认 `web`；本机日常使用的是 `desktop`，
本仓库的安装验证就是在 `desktop` profile 上完成的）。

### 方式 A：DSH 设置界面（推荐）

1. 打开 DSH Web/桌面端 → Settings → Plugins。
2. 选择“从本地目录安装 / Install from folder”，目录填：

   ```
   <本仓库>\dsh-remote-mobile
   ```

   或者由 Agent / CLI 调用 plugin manager 的 `install_bundle`：

   ```text
   install_bundle target = <本仓库>\dsh-remote-mobile
   ```

3. 安装会执行依赖安装、bundle 选择与 HMR 激活；新 bundle 通常无需重启。
4. 打开 Settings → **远程访问**，打开“启用远程访问”。

### 方式 B：DSH CLI（等价命令）

```powershell
dsh plugin --profile web add <本仓库>\dsh-remote-mobile
dsh plugin --profile web enable @dsh-external/dsh-remote-mobile
```

> Profile 选择：用你日常工作的 profile。安装到 `web` 时手机与 `dsh web` 共用插件/技能/MCP；
> 安装到 `desktop` 时与桌面端共用。不要同时把两个 profile 都指向同一个端口。

### 卸载

```powershell
dsh plugin --profile web remove @dsh-external/dsh-remote-mobile
```

或在 Settings → Plugins 中移除 bundle。卸载/停用后网关端口立即关闭，手机显示“已断开”。

---

## 2. 配置

插件行默认配置（`cordis.patch.yml`）：

```yaml
- insert:
    - id: dsh-remote-mobile
      name: '@dsh-external/dsh-remote-mobile'
      config:
        enabled: false      # 默认关闭，必须显式启用
        host: 0.0.0.0       # 局域网监听；SSH 隧道可改 127.0.0.1
        port: 8787
        path: /dsh
        token: ''           # 留空则首次启用时自动生成（>=32 字符）
        workspace: ''       # 新会话默认 cwd；空 = Host 默认工作区
```

运行时修改（设置页 / HTTP API）持久化到：

```
%DSH_HOME%\dsh-remote-mobile\state.json      # 默认 C:\Users\<user>\.dsh\dsh-remote-mobile\state.json
```

其中保存启停状态、监听地址覆盖值、轮换后的令牌（文件权限 0600，不会写入日志/URL）。
Loader 里的 config 是**默认值**，运行时状态优先；旋转令牌只写 state 文件。

### 设置页能力

- 启用/停用开关（立即启动/关闭端口）
- 监听地址、端口、path（保存后按需重启监听）
- 令牌：默认掩码显示 + 复制 + 轮换（轮换后旧客户端立即断开）
- 当前局域网 URL（`ws://192.168.x.x:8787/dsh`）
- 已连接设备数量、待处理审批数量
- 最近一次错误（端口占用、监听失败等）
- 安全警告与防火墙提示

设置页通过同源 HTTP API 与 Host 半通信：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-remote-mobile/api/state` | 状态快照（令牌只返回掩码） |
| POST | `/dsh-remote-mobile/api/update` | `{enabled?,host?,port?,path?}`，持久化并重启监听 |
| POST | `/dsh-remote-mobile/api/rotate` | 生成新令牌并断开旧客户端 |
| POST | `/dsh-remote-mobile/api/token` | 仅 loopback 可调用，返回明文令牌供“复制” |
| POST | `/dsh-remote-mobile/api/pairing` | 仅 loopback，返回 `dshremote://pair?url=...&token=...` 文本 |

所有 POST 需要 `x-dsh-remote-mobile: 1` 请求头，并受同源/loopback 限制。

---

## 3. 手机端连接

1. 手机与电脑同一局域网（建议 5GHz Wi-Fi）。
2. 打开 DSH Remote，地址填设置页里的局域网 URL，例如 `ws://192.168.1.10:8787/dsh`。
3. 令牌填设置页复制的令牌。
4. 连接成功后状态显示“已连接”，会话列表即桌面端的会话。

**防火墙**：Windows 首次监听时会弹窗，请允许“专用网络”入站 TCP 8787；若没有弹窗：

```powershell
New-NetFirewallRule -DisplayName "DSH Remote Mobile" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Private
```

只建议在专用/家庭网络放行；不要暴露到公网。需要跨网时把监听地址改为 `127.0.0.1`，
用 SSH 隧道（例如 `ssh -L 8787:127.0.0.1:8787 user@host`）或 VPN。

---

## 4. 安全模型

- **令牌 = 本机 Agent 的完整操作权**：持有令牌的人可以让 Agent 执行工具（运行命令、读写文件）。
  不要在聊天/截图/公开仓库中泄露令牌。
- 令牌随机生成（≥32 字符），常量时间比较；不写日志、不进 URL（配对文本除外，且仅本机可生成）。
- 默认监听 `0.0.0.0` 供局域网使用；只要本机使用请改 `127.0.0.1`。
- 审批转发只是把 Host 原本的审批问题转给手机，**不绕过** Host 的权限策略、沙箱与工具校验：
  未打开会话继续走桌面端审批；手机打开过且有客户端在线时由手机回答（10 分钟超时，全部客户端
  断开 30 秒后取消）。
- 插件默认关闭；停用立即关闭端口。

详见 [docs/SECURITY.md](docs/SECURITY.md)。

---

## 5. 从外部 bridge 迁移

旧方案 `bridge/dsh-mobile-bridge.mjs` 是一个独立进程，通过 `dsh --profile acp` 子进程转接。
新插件：

| | 旧外部 bridge | 本插件 |
|---|---|---|
| 进程 | 独立 node 进程 + ACP 子进程 | 无，运行在 DSH Host 内 |
| 插件/技能/MCP | 走 `dsh --profile acp` | 直接用日常 profile，桌面端同一批 |
| 桌面端共享会话 | 否（第二个 Agent） | 是（同一 live session） |
| 审批 | ACP 审批 | Host `approval/request` seam |
| 配置 | 命令行参数 + state 文件 | 设置页，默认关闭 |
| 手机协议 | 基准 | 逐帧兼容 |

迁移步骤：

1. 停掉旧 bridge 进程（释放 8787 端口）。
2. 按第 1 节安装插件并在设置页启用（端口 8787）。
3. 手机 App 无需改动，令牌换成设置页里的新令牌。
4. 确认无误后删除/归档 `bridge/` 的启动脚本（保留 `selftest.mjs` 可作历史参考）。

> 若 8787 仍被旧 bridge 占用，插件会显示“端口已被占用”，不会影响 DSH 主进程；
> 停掉旧进程或在设置页换端口即可。

---

## 6. 开发与测试

要求 Node.js ≥ 20；依赖已 vendored（`vendor/ws`），安装时无需联网拉取运行时依赖。

```powershell
cd dsh-remote-mobile

# 单元 + 协议网关测试（mock Host，无模型消耗）
node scripts/run-tests.mjs

# 真机联调：对已启用的真实 Host 跑协议兼容测试
$token = "<设置页复制的令牌>"
node test/live-selftest.mjs --url ws://127.0.0.1:8787/dsh --token $token
# 不消耗模型时：
node test/live-selftest.mjs --url ... --token ... --skip-llm
```

`test/live-selftest.mjs` 覆盖：非法令牌、错误路径、hello/ping、sessions.list/new/open、
prompt 流式 item 与 turn 生命周期、多客户端广播、断线重连、审批允许/拒绝/重连重放、取消、
模型/推理强度切换、设置 API 启停与端口冲突。结果示例见 [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md)。

---

## 7. 兼容性

手机端每个页面依赖的 RPC/事件、以及 Host 能力与协议的映射、限制与替代方案见：

- [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) — 手机页面 ↔ RPC/事件矩阵
- [docs/HOST-API.md](docs/HOST-API.md) — 协议 → DSH Host API 映射与限制
- [docs/TEST-RESULTS.md](docs/TEST-RESULTS.md) — 实测结果

已知限制（均已在实现中替代/降级，不改变外部协议）：

- Host 在流式阶段没有 durable assistant messageId；插件在消息落盘后按协议 id
  （`a:<messageId>` / `t:<messageId>`）快速回放增长中的完整 item，视觉上仍是流式更新，
  且不会产生重复卡片。
- `session.setConfig` 的模型选择与桌面端行为一致：Host 会同时把该选择保存为全局默认模型
  （后续新会话沿用），这是 DSH 自身语义。
- 冷会话恢复时 Host 可能补写中断回合的收尾事件；这是 Host 的恢复语义。
- `sessions.list` 的 title/preview/createdAt/hasTranscript 不在 Host 列表 API 中，
  插件从会话日志/标题服务派生，并在插件内缓存。

---

## 8. 目录结构

```
dsh-remote-mobile/
  package.json           bundle 清单（Host + Client）
  cordis.patch.yml       Loader 插入行（默认关闭）
  icon.svg / locale/     插件面板显示资源
  lib/
    index.js             Host 半：插件入口、设置 HTTP API、启停
    gateway.js           WebSocket 网关：鉴权、RPC、事件广播、审批
    host-bridge.js       DSH Host 适配：真实会话/Agent/模型/审批
    item-mapper.js       Session 事件 → 手机 ChatItem
    protocol.js          冻结协议常量与校验
    state-store.js       运行时状态/令牌持久化
  client/client.js       Client 半：设置页（DSH Web UI 插件）
  test/                  单元、网关、Host 适配、真机自测
  vendor/ws/             vendored ws 8.21.3（MIT，见 vendor/ws/README.md）
  docs/                  安装、安全、Host API 映射、兼容矩阵、测试结果
```

## License

MIT（`vendor/ws` 亦为 MIT，保留其 LICENSE）。
