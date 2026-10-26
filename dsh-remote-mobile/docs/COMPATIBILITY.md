# 手机端页面 / 功能 ↔ RPC / 事件 兼容矩阵

协议基准：`bridge/dsh-mobile-bridge.mjs`、`entry/src/main/ets/model/DshTypes.ets`、
`entry/src/main/ets/service/DshClient.ets`。手机 App 未做任何修改。

## 1. 连接与全局状态

| 手机页面/功能 | 依赖 RPC/事件 | 实现状态 | 备注 |
|---|---|---|---|
| `Index` 连接页：填写 URL/Token 并连接 | `auth` → `hello` / `auth.error`，15s 认证超时 | ✅ | 非 `/dsh` 路径拒绝；错误令牌 4401 |
| 断线提示 / 心跳 | `{"type":"ping"}` → `pong`（手机每 20s） | ✅ | 同时支持 RPC `ping` |
| 顶部状态 “已连接 / DSH 离线 / 已断开” | `hello.online`、`bridge.status`、`connection.status`（手机本地生成） | ✅ | Host 降级时 `bridge.status{online:false,message}` |
| 设置面板显示网关/工作区/Harness/Bridge 版本 | `hello.name/version/workspace/defaultCwd/agent` | ✅ | `agent.version` 目前可能为空字符串（Host 未暴露统一版本服务） |

## 2. 会话列表页（`Index`）

| 手机页面/功能 | 依赖 RPC/事件 | 实现状态 | 备注 |
|---|---|---|---|
| 会话列表（标题、preview、cwd、更新时间、运行中、有历史） | `sessions.list` → `{sessions,online,warning}` | ✅ | 根会话（排除 subagent），updatedAt 降序，最多 80 条 |
| 列表实时更新（标题/preview/运行状态） | `session.updated`（顶层无 sessionId，取 `session.sessionId`） | ✅ | 250ms 节流 |
| 运行状态变化 | `session.updated.session.running` + `turn.status` | ✅ | 桌面端发起的回合也会同步 |
| 新建会话 | `session.new {cwd?}` → `{session,configOptions}` | ✅ | 真实 Host 会话，默认 preset/模型，等待 Agent 就绪后返回 |
| 打开会话 | `session.open {sessionId,cwd}` → `{session,items,configOptions,attached,warning}` | ✅ | live 附着 / 冷恢复 / 失败时只读历史 + warning |
| 刷新列表 | 再次 `sessions.list` | ✅ | 首次冷读会填充缓存 |
| 无法恢复时的横幅与重试 | `attached:false` + `warning` | ✅ | 冷读日志失败才返回 rpc.error |

## 3. 聊天页（`ChatPage`）

| 手机页面/功能 | 依赖 RPC/事件 | 实现状态 | 备注 |
|---|---|---|---|
| 打开时恢复历史 | `session.open` → `items`（最多 200） | ✅ | 历史从 Host session log 派生，不重跑模型 |
| 发送 prompt | `session.prompt {sessionId,text}` → `{stopReason}` | ✅ | 同一会话单 in-flight；失败返回 rpc.error 并附 notice item |
| 运行中状态/停止按钮 | `turn.status running`；`session.cancel {sessionId}` | ✅ | 取消后 prompt RPC 返回 `cancelled` |
| 用户消息气泡 | `item.upsert`，`item.id = u:<messageId>` | ✅ | 桌面端用户消息也会出现在手机（同一会话） |
| 思考卡片 | `item.upsert`，`item.kind=thought`，`id=t:<messageId>` | ✅ | 来自 assistant message 的 reasoning 块；完整 item 替换 |
| 助手文本 | `item.upsert`，`kind=assistant`，`id=a:<messageId>` | ✅ | 消息落盘后按增长中的完整 item 分片重放 |
| 工具卡片（执行中→完成/失败） | `tool/call` → `item.upsert status=in_progress`；`tool/result` → `completed/failed` | ✅ | 同一 `tool:<toolCallId>` item；含输入 6000 / 结果 16000 截断 |
| 代码块/ Markdown 渲染 | `item.text` | ✅ | 手机端自行渲染 |
| 上下文占用百分比 | `usage.updated {sessionId,used,size}` | ✅ | used=tokenMeter，size=contextWindow；缺失时不发送 |
| 模型/推理强度底栏 | `configOptions`（open/new 返回） + `config.updated` | ✅ | 模型 value=`["provider","model"]`；effort 空串=默认 |
| 切换模型/推理强度 | `session.setConfig {sessionId,configId,value}` → `{configOptions}` | ✅ | 走 Host `selectModel`（会修改全局默认模型，见限制） |
| 只读缓存提示 | `attached:false` 时禁用输入，显示 warning | ✅ | 手机端自身逻辑 |
| 空会话引导 | 新建后 items=[] | ✅ | |

## 4. 审批弹窗（`Index` approvalOverlay）

| 手机页面/功能 | 依赖 RPC/事件 | 实现状态 | 备注 |
|---|---|---|---|
| 收到工具审批 | `approval.request {requestId,sessionId,toolCallId,title,label,input,options}` | ✅ | label 中文友好名；input 截断 6000；10 分钟超时 |
| “允许一次” | `approval.respond {requestId,optionId:"allow-once"}` → `{ok:true}` | ✅ | 对应 Host `allowed-once` |
| “拒绝” | `optionId:"reject-once"` | ✅ | 对应 Host `rejected`，工具 item 变 failed |
| 其他端已处理时移除弹窗 | `approval.resolved {requestId,sessionId,decision,optionId,reason}` | ✅ | 多客户端第一个响应生效 |
| 过期/重复响应 | rpc.error（“授权请求已失效”） | ✅ | |
| 断线重连后仍能看到待审批 | 认证成功后重放 pending `approval.request` | ✅ | 30s 无客户端后取消 |
| 桌面端审批不受影响 | 未打开会话的审批继续 `next()` | ✅ | prepend 监听但只拦截手机打开过的会话 |

## 5. 设置/关于页（`Index` settingsSheet）

| 手机页面/功能 | 依赖 | 实现状态 | 备注 |
|---|---|---|---|
| 重新连接 | `reconnect()` → hello + `sessions.list` | ✅ | |
| 修改连接/断开 | 客户端行为 | ✅ | |
| 显示 Bridge/Harness 版本 | hello.version / hello.agent | ✅ | |
| 显示工作区 | hello.workspace/defaultCwd | ✅ | |

## 6. 协议字段兼容性

- `SessionSummary` / `ChatItem` / `ConfigOption` / `ApprovalOption` 字段名、类型与手机
  `DshTypes.ets` 完全一致；新增字段只增不改，手机忽略未知字段。
- RPC `id` 原样回传（手机用字符串 id）；未知方法 `-32601`、参数错误 `-32602`、内部错误 `-32603`。
- 事件帧为 `{type:"event", event, ...扁平字段}`；`session.updated` 的 sessionId 在
  `session.sessionId` 内（与手机过滤逻辑一致）。
- 单帧上限 1MB；超过会由 WebSocket 层关闭连接（1009），不影响其他客户端/Host。
- `auth → hello` 与旧 bridge 字段一致（`name` 为 `dsh-remote-mobile`，手机只展示不校验）。

## 7. 未实现（非目标，手机端当前不调用）

- 文件浏览器、终端 UI、插件管理 UI（本插件不做）
- ACP 专有的 `session/list` 分页、`session/resume`、`session/set_config_option` 等内部方法
- `server.info` 已实现（与 hello 相同），手机当前不调用
- 图片附件上传/下载（手机端当前只发送文本；协议无该字段）
- 账号体系、公网中继、推送通知
- Web UI cookie 复用为手机鉴权（明确禁止；手机使用独立令牌）
