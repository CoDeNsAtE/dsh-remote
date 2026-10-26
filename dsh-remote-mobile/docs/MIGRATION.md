# 从外部 bridge 迁移到 Host 插件

旧方案：`bridge/dsh-mobile-bridge.mjs`（外部 Node 进程，WebSocket 8787 + 子进程 `dsh --profile acp`）。
新方案：`dsh-remote-mobile`（DSH Host 进程内插件，无子进程、无 ACP）。

## 1. 架构对照

```
旧：
  手机 --ws--> dsh-mobile-bridge.mjs --stdio JSON-RPC--> dsh --profile acp（第二个 Harness/Agent）
  桌面端与手机各自一套 Agent，会话不共享；插件/技能/MCP 需在 acp profile 里重新装配。

新：
  手机 --ws--> dsh-remote-mobile（Host 插件）
                 |-- ctx.sessionController / ctx.agents / ctx.sessions（与桌面端同一批 live 会话）
                 |-- ctx.sessionTitle / ctx.llm / ctx.agentDefaultModel
                 |-- ctx.on('approval/request')（Host 原生审批 seam）
                 '-- ctx.webServer（设置页 HTTP API）
  桌面端与手机共享同一个 live Agent，消息双向可见；直接使用日常 profile 的插件/技能/MCP。
```

## 2. 迁移步骤

1. **停止旧 bridge**：结束 `node dsh-mobile-bridge.mjs` 进程（释放 8787）。
2. **安装插件**：把 `dsh-remote-mobile/` 安装到日常 profile（见 [INSTALL.md](INSTALL.md)）。
3. **启用并取令牌**：Settings → 远程访问 → 启用 → 复制令牌（或 HTTP API，见 INSTALL）。
4. **手机改填新地址/令牌**：URL 仍然是 `ws://<host>:8787/dsh`，令牌换成插件生成的。
   App 无需升级、无需改代码。
5. **验证**：跑 `node test/live-selftest.mjs ...` 或直接手机走一遍会话/审批。
6. **归档旧 bridge**：确认后可删除 `bridge/` 的启动脚本（`selftest.mjs` 可留作协议参考）。

## 3. 行为差异（预期内）

| 项目 | 旧 bridge | 新插件 | 影响 |
|---|---|---|---|
| 会话真源 | ACP 子进程 | Host live session | 桌面/手机共享同一会话，桌面端能看到手机消息，反之亦然 |
| 桌面端已打开的会话 | 无法真正附着 | `session.open` 附着同一 Agent，不重建 | 消息互通、状态互通 |
| 会话列表 | ACP `session/list` | `sessionController.list` + 日志派生 title/preview | 字段更完整 |
| 标题 | ACP session_info_update | Host session-title（不再为手机单独调模型） | 与桌面端一致 |
| 审批 | ACP request_permission → bridge 审批表 | Host `approval/request` waterfall，仅手机打开过的会话 | 不绕过权限/沙箱；桌面端其它会话不受影响 |
| 模型切换 | ACP `session/set_config_option` | `sessionController.selectModel` | 编码仍是 `["provider","model"]`；会同步影响全局默认模型（Host 语义） |
| 令牌 | 命令行参数/终端输出 | 设置页生成/持久化/轮换 | 默认关闭，显式启用才监听 |
| 状态 | 终端输出 | Settings 页 + `/health` + `/dsh-remote-mobile/api/state` | 端口占用等错误可视化 |
| 手机兼容 | 基准 | 逐帧兼容 | App 零改动 |

## 4. 回滚

1. 停用/卸载插件（Settings → 远程访问关闭，或 `dsh plugin remove`）。
2. 重新启动旧 `bridge/dsh-mobile-bridge.mjs`（旧令牌仍有效，直到你更换）。
3. 手机填回旧地址/令牌。

`state.json` 不影响旧 bridge；卸载插件后可删除 `%DSH_HOME%\dsh-remote-mobile\`。

## 5. 兼容性验证

旧协议自测脚本 `bridge/selftest.mjs` 针对 mock ACP，不能直接用于新插件；对应的真机协议自测是
`dsh-remote-mobile/test/live-selftest.mjs`（覆盖原有的握手、列表、新建/打开、prompt 流式、
审批、配置、取消，并增加多客户端/重连/审批重放/端口冲突/设置 API）。协议字段与旧 bridge
保持一致，见 [COMPATIBILITY.md](COMPATIBILITY.md)。
