# 协议 → DSH Host API 映射

本文件记录 `dsh-remote-mobile` 的外部协议如何落到 DSH Host（0.2.1-rc.3，desktop/web profile）的实际
服务/事件上，以及无法 100% 对齐时的限制与替代方案。内部 API 的发现与验证基于从安装包中提取的
运行时源码/类型目录（开发期研究产物，不随插件安装）。

## 1. 使用到的 Host 服务

| 服务 | 用途 | 访问方式 |
|---|---|---|
| `ctx.sessionController` | 会话列表 / 冷读历史 / 新建会话 / 附着或恢复 Agent / 模型选择 / 模型 catalog | 直接调用 public 方法（`@Remote` 只是元数据，进程内调用无需 Remote 装配） |
| `ctx.agents` | 查找 live Agent（同一会话不重复创建） | `ctx.get('agents').get(sessionId)` |
| `ctx.sessions` | 查找 live Session、读取事件 | `ctx.get('sessions').get(id)` |
| `ctx.sessionTitle` | live 会话标题 | `get(session)` |
| `ctx.sessionQuery` | （可选）冷会话列表/标题快照 | 插件当前用 `sessionController.inspect` 冷读 |
| `ctx.agentDefaultModel` | 新会话/未选择时的默认模型 | `currentSelection()` |
| `ctx.sessionProjections` | live 会话模型选择投影（可选） | `stateOf(session,'modelSelection')` |
| `ctx.workspaceRegistry` / `ctx.workingDirectory` | 默认工作区 | 首选工作区路径 / `defaultDirectory` |
| `ctx.tokenMeter` | `usage.updated` 的 used 值 | `measure(session).totalTokens` |
| `ctx.webServer` | 设置页 HTTP API | `register({kind:'exact',...})` |
| `ctx.approval` 的 `approval/request` waterfall | 工具审批转发 | `ctx.on('approval/request',...,{global:true,prepend:true})` |
| `ctx.llm`（间接） | 模型 catalog / resolveCallConfig | 通过 `sessionController.modelCatalog/selectModel` |

插件不 import 任何 `@deepseek-ai/dsh-*` 运行时模块，因此不会与 Host 版本/模块实例冲突；
唯一运行时依赖是 vendored `ws`。

## 2. 会话列表 `sessions.list`

```
sessionController.list({}) -> { items: SessionSummary[] }
```

`SessionSummary` 只有：`sessionId, updatedAt, running, blank, agentAvailable, cwd?, origin?, parentSessionId?, projections?`。

- 过滤 `origin === 'subagent'`，只保留根会话；`updatedAt` 降序；最多 80 条。
- `createdAt`：live 会话取 `session.header.createdAt`；冷会话 `sessionController.inspect(id).meta.createdAt`。
- `title`：live 用 `ctx.sessionTitle.get(session)`，否则取日志中最后一个 `session/title` 事件；
  再退化为第一条 user prompt 首行（≤48）。
- `preview`：取最近 user/assistant 文本，去代码块、压缩空白、≤96。
- `hasTranscript`：日志中存在 user/assistant/tool 事件。
- live 会话读取 `session.snapshotEvents()`（Host 标记 deprecated 但仍是唯一同步读取方式；
  插件只读、不 append，不会触发 reentrancy 限制）。
- 结果按 `sessionId + updatedAt` 缓存提示字段；只有 `updatedAt` 变化时才重新冷读。
- Host 异常时返回 `online:false` + `warning`，并广播 `bridge.status {online:false}`。

## 3. 新建会话 `session.new`

```
sessionController.create({ cwd }) -> { sessionId, agentPreset? }
```

- 内部走 `composeAgent` + 用户 profile 的默认 Agent preset（本机为 `ptc`）→ 真实装配插件、技能、MCP、工具，
  与桌面端新会话完全一致；模型取 `agentDefaultModel.currentSelection()`。
- 创建返回时 Agent 已发布，用 `ctx.get('agents').get(sessionId)` 取 live Agent。
- 插件随后用 `session.header` 生成 summary，并返回由 Host 模型 catalog 构造的 `configOptions`。
- 不调用标题模型：标题由 Host 的 session-title 自动流程在首个 prompt 后生成（与桌面端一致）。

## 4. 打开会话 `session.open`

1. 如果 `ctx.get('sessions').get(id)` 存在 → 附着，`attached:true`。
2. 否则 `sessionController.resolveAgent(id)`：Host 内部去重、复用桌面端已存在的 Agent；冷会话恢复
   只加载持久化日志，不跑模型。
3. 恢复失败（如 `session/writer-held`、另一个 Host 持有写句柄）→ `sessionController.inspect(id)`
   冷读日志，返回 `attached:false` + items + `warning`（手机端显示只读缓存）。
4. 写句柄/会话不存在时返回 `rpc.error`。
5. items 由 `SessionItemStore` 从事件日志派生，最多 200 条；`configOptions` 由模型 catalog + 当前选择构造。

## 5. Prompt 与取消

插件不使用 `sessionController.prompt`（它只返回 admission，且没有 durable message id），而是按
Host Agent 接口直接驱动：

```js
const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
agent.followup(message)          // 入队并唤醒同一个 live Agent
```

- 用 `ctx.on('agent/inbox/claimed', ({agent, message, turn}))` 按我们自己的 `message.id` 关联 turn
  （`turn/start` 在 claimed 之前，不能单独用于关联）。
- `ctx.on('session/event', ...)` 监听 `turn/end`：`completed→end_turn`、`aborted/interrupted→cancelled`、
  `max-tokens→max_tokens`、`error→rpc.error + notice item`。
- 插件侧对每个会话维护一个 in-flight 标记；重复 prompt 返回 `-32603`（ACP 语义；Host 本身允许排队）。
- `session.cancel` → `agent.cancel({ kind: 'user' })`；审批未决时同时取消对应审批。
  取消与 prompt admission 竞争时，插件用 pendingCancel 标记保证 prompt RPC 最终返回 `cancelled`。
- 长任务没有超时；只有手机协议层自己决定等待多久。

## 6. 事件 → 手机事件

| Host 事件 | 手机事件 | 说明 |
|---|---|---|
| `session/event` + 已打开会话 | `item.upsert` | 由 `SessionItemStore` 派生完整 item；id 规则见下 |
| `user/message` / `assistant/message` / `session/title` / `turn/*` | `session.updated` | title/preview/running/updatedAt 变化，250ms 节流 |
| `agent/status` | `turn.status`（去重后） | 桌面端发起的回合也能同步到手机 |
| `turn/end`（prompt 关联） | `turn.status idle` + RPC resolve | |
| `assistant/message` 的 `usage` + `session.requestContext().contextWindow` | `usage.updated` | used 来自 `tokenMeter.measure(session).totalTokens` |
| `model/selection`（手机打开过的会话） | `config.updated` | 用 catalog + 选择重建完整 options |
| `llm/adapters-updated` | `config.updated` | 模型拓扑变化 |
| 网关启停 / Host 降级 | `bridge.status` | |

item id 规则严格按手机协议：

| 来源 | id |
|---|---|
| user message | `u:<messageId>` |
| assistant 文本 | `a:<messageId>` |
| reasoning/thought | `t:<messageId>` |
| tool call/result | `tool:<toolCallId>` |
| notice | `n:<uuid>` |

同一 messageId 的多个文本/推理块合并；tool_call 与 tool_result 合并为同一个 tool item；
输入截断 6000、结果 16000、item.text 60000；非文本结果用 `[图片]` / `[文件 name]` 占位。

## 7. 模型配置

`configOptions` 结构（手机 `ConfigOption`）：

- `model`：`currentValue = JSON.stringify([provider, model])`；choices 来自
  `sessionController.modelCatalog()` 的 `groups[].models[]`（`value` 同编码，`group`=provider 显示名）。
- `reasoning_effort`：`currentValue` 为 effort id 或空字符串（provider default）；choices 含 `''` 默认 +
  当前模型 `reasoning.efforts`。模型没有 reasoning 元数据时不返回该 option。

`session.setConfig`：

- `model`：解析 JSON pair → `sessionController.selectModel({sessionId, provider, model})`。
- `reasoning_effort`：当前选择 + `reasoningEffort: value || undefined` → `selectModel`。
- Host 会校验并规范化（`llm.resolveCallConfig`），追加 durable `model/selection` 事件，只影响后续模型步骤。
- **注意**：与桌面端行为一致，Host 的 `selectModel` 会在后台把该选择保存为**全局默认模型**；
  手机切换模型会影响以后新建的会话。这是 DSH 自身语义，不是插件额外行为。

## 8. 审批

```js
ctx.on('approval/request', (request, next) => { ... }, { global: true, prepend: true })
```

- 该 waterfall 对**所有**会话触发；插件只拦截“至少一个手机客户端打开过该会话且当前有客户端在线”的请求，
  其余一律 `next()` 交给 Host/桌面端。
- 必须用 `prepend:true`：桌面端在 Host 启动时注册了把审批转发到浏览器的 root listener，否则会被它先应答。
- 手机选项固定为 `allow-once`(allow_once) / `reject-once`(reject_once)；返回
  `allowed-once` / `rejected` / `cancelled`。
- `tool/call` 事件先于审批落盘，插件用 `callId` 从 item store 取工具名/参数（截断 6000）作为 `input`；
  `displayReason` 只在内存请求里，直接作为友好 label 使用。
- 10 分钟超时取消；全部客户端断开 30 秒后取消；重连后 replay pending approval。
- 插件只做“把 Host 的审批问题转发给手机”，不修改 Host 的权限策略/沙箱；`permission policy=never`
  时 Host 根本不会进入 answerer 阶段。

## 9. 已知限制与替代

| 限制 | 影响 | 本插件的处理 |
|---|---|---|
| Host 在流式阶段没有 assistant messageId（消息落盘时才生成） | 无法在 token 级流式时使用 `a:<messageId>` 稳定 id | 消息落盘后立即按 durable id 发送“增长中的完整 item”（分片重放），不产生重复卡片；真实 token 级流式需放弃冻结 id 契约，不做 |
| `SessionSummary` 不含 title/preview/createdAt | 列表需要额外读取 | live 走标题服务 + 日志尾扫描；cold 走 `inspect` 冷读并按 updatedAt 缓存 |
| `sessionController.prompt` 只返回 admission | 无法直接知道回合结束 | 直接 mint UserMessage + followup，按 inbox/claimed 关联 turn |
| Host 没有 per-session 模型选择读取 API（仅投影） | 需要自行折叠 | 优先 live 投影 / durable `model/selection`+`request/header` 折叠 / 全局默认 |
| `selectModel` 修改全局默认模型 | 手机切换影响新会话 | 保持 Host 语义，文档说明 |
| 冷会话 resume 会取得写句柄并可能补写中断回合收尾 | 与桌面端同时打开同一冷会话可能 writer-held | 降级为 `attached:false` + 历史只读 + warning |
| 审批没有 durable request id 暴露给 answerer | 手机 requestId 只能由插件生成 | 插件生成 `ap-<n>`，在事件与 RPC 间保持一致；重连按内存表重放 |
| 桌面端与手机同时打开同一 live 会话 | 双方都能操作 | 这是设计目标：共享同一个 Agent；prompt 只在手机侧做 in-flight 去重 |
