# 测试结果

测试日期：2026-10-26
测试环境：

- Windows，DSH Desktop 0.2.1-rc.3，profile = `desktop`（用户日常 profile；`web` profile 同样支持）
- 插件：`@dsh-external/dsh-remote-mobile` 0.1.0，安装方式 `plugin_manager install_bundle`（本地目录 link + HMR）
- Host LLM：deepseek-official / deepseek-flash（真实模型回合）
- 旧外部 bridge 进程占用了默认端口 8787，因此真机测试在 **8788** 上完成；端口冲突/设置页改端口
  两项也已被测试覆盖（见下）。默认配置仍为 8787。

## 1. 单元 / 网关 / Host 适配测试

命令：

```powershell
cd dsh-remote-mobile
node scripts/run-tests.mjs
```

结果（最终代码）：

```
tests 52
pass 52
fail 0
```

覆盖：

- 协议常量/错误码/hello/token 比较与掩码/路径规范化/审批选项
- ChatItem 映射：`u:/a:/t:/tool:/n:` id、文本合并、工具 in_progress→completed/failed、
  图片/文件占位、6000/16000/60000 截断、200 条上限、模型选择折叠
- 状态存储：启停/端口/令牌持久化、损坏文件降级
- WebSocket 网关（mock Host）：
  - 鉴权成功/错误令牌/15s 超时/非 `/dsh` 路径
  - RPC 未知方法 `-32601`、参数错误 `-32602`、字符串 id 原样回传
  - sessions.list/new/open、`attached:false`+warning
  - prompt 事件流、重复 in-flight 拒绝、cancel、setConfig
  - 审批：允许/拒绝/非法选项/重复响应/超时/无客户端 30s 取消/断线重连重放
  - 多客户端广播 + 第一个审批响应生效
  - 令牌轮换断开旧客户端
  - 端口冲突返回错误且不影响已有网关
  - 超过 1MB 帧断开连接、服务端继续健康
- Host 适配（假 Host）：列表派生、真实会话创建、live 附着/冷恢复/恢复失败降级、
  prompt/error notice/cancel、模型+effort 切换、审批只拦截手机打开过的会话。

## 2. 真机协议自测（真实 DSH Host + 真实模型）

命令（token 来自 Settings → 远程访问 → 复制令牌）：

```powershell
node test/live-selftest.mjs `
  --url ws://127.0.0.1:8788/dsh `
  --token "<token>" `
  --settings http://127.0.0.1:13734 `
  --llm-timeout 180000
```

最终结果（测试运行输出，开发日志已清理）：

```
19 passed, 0 failed, 0 skipped
```

| # | 检查 | 结果 |
|---|---|---|
| 1 | 非法 token → `auth.error` + 4401 | PASS |
| 2 | 非 `/dsh` 路径拒绝 | PASS |
| 3 | hello（name/version/path/workspace/defaultCwd/agent）、ping/pong、server.info | PASS |
| 4 | `sessions.list` 根会话字段完整、updatedAt 降序 | PASS |
| 5 | `session.new` 创建真实 Host 会话，模型值 `["provider","model"]` | PASS |
| 6 | `session.open` 附着 + items + configOptions | PASS |
| 7 | 模型切换往返并恢复 | PASS |
| 8 | reasoning effort 切换往返并恢复 | PASS |
| 9 | 真实 prompt 回合：user/assistant item、turn.status running→idle、stopReason | PASS |
| 10 | 再次 open 读到历史，hasTranscript/running 正确 | PASS |
| 11 | 第二客户端收到相同 item/turn 事件并可附着 | PASS |
| 12 | 断线重连后历史仍在、无重复 Agent、会话 idle | PASS |
| 13 | **真实工具审批 allow-once**：手机收到 approval.request（label=终端命令，input 含审批原因 + 代码），允许后工具 completed、回合结束 | PASS |
| 14 | **真实工具审批 reject-once**：拒绝后工具 item failed | PASS |
| 15 | **断线后 pending approval 重放**：新客户端收到 approval.request 并回答 | PASS |
| 16 | **取消**：运行中的回合 `session.cancel` → prompt 返回 `cancelled`，turn.status idle | PASS |
| 17 | 设置 API `/state`：enabled/listening/tokenMasked/urls/clients/安全警告 | PASS |
| 18 | 设置 API disable → 端口关闭、客户端断开；enable → 恢复监听并可重连 | PASS |
| 19 | 设置 API 端口被占用 → `lastError` 报告，网关未 crash，恢复原端口后可用 | PASS |

真实审批样例（allow-once，来自运行日志/探针）：

```json
{
  "type": "event",
  "event": "approval.request",
  "requestId": "ap-2",
  "sessionId": "session-291c345a-...",
  "toolCallId": "call_00_...:ptc:1",
  "title": "run_code",
  "label": "终端命令",
  "input": "审批原因：允许本次操作使用 danger-full-access 权限：目标文件位于工作区之外的系统临时目录……\n\n{ \"code\": \"...tools.pwsh({ ... sandbox_permissions: \\\"danger-full-access\\\" })\" }",
  "options": [
    { "optionId": "allow-once", "name": "允许一次", "kind": "allow_once" },
    { "optionId": "reject-once", "name": "拒绝", "kind": "reject_once" }
  ]
}
```

说明：审批由 DSH 的审批策略/沙箱升级触发（`workspace-write` 下写工作区外临时目录）；
插件只转发 Host 的审批问题，不修改策略。

## 3. 设置页（Client 半）验证

Live Slot 检查（`cordis_inspect_query` client `Slots.listSubTree`）：

- `settings.section` occupants 含：`{"registrant":"remote-mobile","id":"remote-mobile","order":45,"active":true}`
  → Settings 导航出现“远程访问”页。
- `plugins.bundle.config` occupants 含：`{"registrant":"remote-mobile","key":"@dsh-external/dsh-remote-mobile","active":true}`
  → 侧边栏 Plugins 面板的 bundle 配置页也挂载同一组件。

页面数据来自同源 `GET /dsh-remote-mobile/api/state`（已验证在带 `Origin: http://127.0.0.1:13734`
的浏览器式请求下返回 200 与完整状态）。页面元素包含：启用开关、监听地址/端口/path、局域网 URL、
掩码令牌 + 复制 + 轮换、已连接设备数、待处理审批数、最近错误、安全警告、防火墙提示。

> 限制：本环境无法进行浏览器截图/DOM 断言，以上为 live slot 注册 + HTTP API 验证；
> 视觉呈现未做人工截图确认。

## 4. 与验收标准对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 1 手机填地址+令牌显示已连接 | ✅ 协议验证 | live #3；手机侧 UI 固定逻辑 |
| 2 会话列表标题/preview/cwd/时间/运行状态 | ✅ | live #4；契约测试 |
| 3 新会话、prompt、user/thought/assistant/tool 卡片顺序 | ✅ | live #5/#9；tool 卡片由 tool/call+tool/result 驱动 |
| 4 手机弹审批、允许完成/拒绝失败 | ✅ 真实 Host | live #13/#14 |
| 5 运行中取消，回合结束状态正确 | ✅ | live #16 |
| 6 切换模型/推理强度，重开看到历史 | ✅ | live #7/#8/#10 |
| 7 重连看到运行中会话与历史、无重复 Agent、不丢消息 | ✅（重连时回合已结束；运行中会话的 `running` 由 live summary/事件同步） | live #12 |
| 8 第二设备看到相同事件、审批第一个响应生效 | ✅ | live #11；网关测试“first approval answer wins” |
| 9 桌面/手机同一 live session 互通 | ✅ 架构保证 + live 会话 attach | `session.open` 对 live session 直接附着同一 Agent，不创建第二个；桌面会话出现在手机列表 |
| 10 非法 token/非 /dsh/端口冲突明确错误且不影响主进程 | ✅ | live #1/#2/#19；网关测试 |
| 11 停用后端口关闭、重新启用恢复 | ✅ | live #18 |

## 5. 桌面端 live 会话附着验证（验收 #9 读侧）

用手机协议直接 open 桌面端当前正在运行的会话（本 Agent 会话，`running:true`）：

```
desktop summary {"sessionId":"session-7b5c66b5-...","title":"# 任务：为 DSH 开发 dsh-remote-mob","running":true,"hasTranscript":true,...}
open {"attached":true,"warning":"","running":true,"items":200,"kinds":{"thought":71,"tool":129}}
```

- `attached:true` 且 `running:true`：附着到桌面端同一个 live Agent，而不是创建第二个 Agent。
- `items:200`：返回最近 200 条按时间排序的 transcript（该会话最近活动以工具/思考为主，
  较早的 assistant 文本已超出 200 条窗口）。
- 手机发 prompt 会进入同一 live 会话（由 live 测试 #9/#11 与架构保证），桌面端可继续看到。

## 6. 其它已执行的验证

- 安装：`plugin_manager install_bundle` 成功（本地目录 link、bundle row 插入、HMR 激活）。
- 重新启用：`set_plugin disable/enable` 多次均 `application: applied`，无 warnings。
- HMR：Host 半修改后通过插件开关重载生效；Client 半修改由 `dsh-client-hmr` 约 0.5s 内热替换
  （设置页 slot 注册在修改后仍为 active）。
- 端口：默认 8787 被本机旧 `dsh-mobile-bridge` 占用时，设置 API 正确返回
  `lastError=端口 ... 已被占用`，插件/Host 未崩溃；改用 8788 后全部通过。
- 语法/清单：`node --check` 全部 JS/MJS 通过；`package.json`、`locale/*.json` JSON 解析通过。

## 6. 已知测试缺口

- 手机 App 真机（HarmonyOS 设备）本环境不可用；协议帧由同一份 `DshTypes.ets`/`DshClient.ets`
  契约与真机自测客户端验证。
- 浏览器截图/视觉验收未执行（无浏览器控制），设置页以 live slot + HTTP API 验证。
- 桌面端 UI 与手机同时操作同一 live session 的“双向消息”以架构（同一 Agent/Session）和
  live attach 验证，未做双 UI 人工对照。
- 默认端口 8787 的最终验收受旧 bridge 占用影响；插件在 8788 完成全部验收，端口/占用行为本身已覆盖。
