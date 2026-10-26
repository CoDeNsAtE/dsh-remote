# 测试说明

## 1. 测试分层

| 层 | 文件 | 说明 |
|---|---|---|
| 协议/工具函数 | `test/protocol.test.mjs` | hello、token 比较/掩码、路径、错误码、审批选项、截断 |
| 事件映射 | `test/item-mapper.test.mjs` | `u:/a:/t:/tool:/n:` id 规则、合并、工具状态、占位符、选择折叠、上限 |
| 状态存储 | `test/state-store.test.mjs` | 启停/端口/令牌持久化、损坏文件降级、默认路径 |
| WebSocket 网关 | `test/gateway.test.mjs` | 鉴权成功/失败/超时、错误路径、RPC 错误码、sessions/new/open、prompt 事件、取消、setConfig、审批允许/拒绝/超时/重放、多客户端、令牌轮换、端口冲突、1MB 上限、无客户端取消 |
| Host 适配层 | `test/host-bridge.test.mjs` | 用脚本化假 Host（实现 sessionController/agents/sessions/sessionTitle/agentDefaultModel 等）验证：列表派生、真实会话创建、live 附着/冷恢复/降级、prompt/取消、模型切换、审批拦截范围 |
| 真机协议自测 | `test/live-selftest.mjs` | 对已启用的真实 DSH Host 端到端跑手机协议（含真实模型回合与审批） |

网关测试使用 vendored `ws` 作为客户端；Host 适配测试注入假 Harness，不启动真实 Host、不消耗模型。

## 2. 运行

```powershell
cd dsh-remote-mobile
node scripts/run-tests.mjs
```

> 说明：本仓库环境禁止子进程管道（`node --test` 会 spawn 每个测试文件），因此
> `scripts/run-tests.mjs` 在同一进程内 import 全部测试文件；在普通机器上也可以直接
> `node --test test/`。

真实 Host 联调（需要插件已安装并启用；`--token` 从设置页复制）：

```powershell
node test/live-selftest.mjs `
  --url ws://127.0.0.1:8787/dsh `
  --token "<token>" `
  --settings http://127.0.0.1:13734

# 不花钱/不跑模型，只测连接、会话、配置、设置 API：
node test/live-selftest.mjs --url ... --token ... --skip-llm
```

可选参数：

| 参数 | 说明 |
|---|---|
| `--skip-llm` | 跳过 prompt/审批/取消（不消耗模型） |
| `--skip-settings` | 跳过设置 HTTP API 检查 |
| `--rotate-token` | 结束时测试令牌轮换（会让旧客户端断开） |
| `--llm-timeout <ms>` | 审批/模型等待预算（默认 180000） |

## 3. 真机自测覆盖的验收点

1. 非法 token → `auth.error` + 4401；非 `/dsh` 路径拒绝
2. hello / ping-pong / server.info 字段形状
3. `sessions.list` 根会话、字段、按 updatedAt 降序
4. `session.new` 创建真实 Host 会话（默认 preset/模型），返回模型 JSON 编码
5. `session.open` 附着 live 会话；历史/配置返回
6. `session.setConfig` 模型与 reasoning effort 往返（恢复原值）
7. `session.prompt` 真实回合：user/assistant item、turn.status running→idle、stopReason
8. 再次 open 能读到历史，summary 的 hasTranscript/running 正确
9. 第二个客户端收到同样的 item/turn 事件；可附着同一会话
10. 断线重连后重新 open：历史存在、没有重复 Agent、会话 idle
11. 审批 allow-once：工具卡片 completed，结果包含命令输出
12. 审批 reject-once：工具卡片 failed
13. 审批重放：断线后新客户端收到 pending approval.request 并可回答
14. 取消：进行中的回合返回 `cancelled` 且 turn.status idle
15. 设置 API：/state 字段与安全警告；disable 关闭端口、enable 重新监听；端口冲突报错不 crash
16. （可选）令牌轮换：旧客户端断开、旧 token 失效、新 token 可连接

> 真实审批是否出现取决于 Host 的审批策略/沙箱策略与模型的工具选择。自测在约定时间内
> 等不到 `approval.request` 时会标记 SKIP（不是 PASS），结果文件会记录。

## 4. 常见调试

- 查看网关状态与内部诊断（`diagnostics` 字段：监听是否挂上、收到多少 session 事件、
  in-flight、已打开会话的 item 数）：

  ```powershell
  Invoke-RestMethod http://127.0.0.1:13734/dsh-remote-mobile/api/state | ConvertTo-Json -Depth 5
  ```

- 网关健康检查（独立端口）：`http://127.0.0.1:<port>/health`
- Host 半代码改动后需重装/重启；Client 半改动刷新页面即可。
- 详细结果见 [TEST-RESULTS.md](TEST-RESULTS.md)。
