# DSH Remote

DeepSeek Harness（DSH）的手机远程控制方案，包含两部分：

| 目录 | 内容 |
|---|---|
| `entry/`、`AppScope/`、`hvigor/` | **DSH Remote** HarmonyOS 手机 App（DevEco Studio 工程）：连接 DSH、会话列表、聊天、模型切换、工具审批 |
| [`dsh-remote-mobile/`](dsh-remote-mobile/README.md) | **DSH Host 插件**：在 DSH 进程内启动带令牌鉴权的 WebSocket 网关，让手机直接驱动日常生活中同一个 DSH（同一批真实会话、插件、技能、MCP、工具与审批） |
| `bridge/` | 旧版外部 ACP bridge（已被 Host 插件取代，保留作为协议参考） |

## 它解决什么

- 手机 App 零改动即可连接运行中的 DSH Host：`ws://<host>:8787/dsh` + 访问令牌
- 手机与桌面端共享**同一个 live 会话**：手机发的消息桌面端可见，桌面端的回合手机能同步
- 文本 prompt、流式 item、取消、模型/推理强度切换
- 工具审批转发到手机（只拦截手机打开过的会话，不绕过 DSH 权限/沙箱）
- 多客户端、断线重连、审批重放、令牌轮换
- 插件默认关闭；在 DSH 设置页“远程访问”中启用、配置和复制令牌

## 快速开始（插件）

```powershell
# 安装到日常使用的 DSH profile（把 desktop 换成 web 如果你用 dsh web）
dsh plugin --profile desktop add "<本仓库绝对路径>\dsh-remote-mobile"
```

然后在 DSH Settings → **远程访问** 中启用，复制局域网 URL 和令牌，填到手机 App 即可。

完整说明见 [dsh-remote-mobile/README.md](dsh-remote-mobile/README.md) 与
[docs/INSTALL.md](dsh-remote-mobile/docs/INSTALL.md)。

## 手机 App

用 DevEco Studio 打开本仓库根目录构建；App 内填入网关地址与令牌后即可使用。
App 协议与 `bridge/dsh-mobile-bridge.mjs` 完全一致（协议基准），Host 插件逐帧兼容。

## 测试

```powershell
cd dsh-remote-mobile
node scripts/run-tests.mjs           # 单元 + 网关 + Host 适配（mock Host）
node test/live-selftest.mjs --url ws://127.0.0.1:8787/dsh --token <token>
```

测试结果与兼容矩阵见
[docs/TEST-RESULTS.md](dsh-remote-mobile/docs/TEST-RESULTS.md)、
[docs/COMPATIBILITY.md](dsh-remote-mobile/docs/COMPATIBILITY.md)。

## 安全

持有访问令牌的人可以驱动本机 Agent 执行工具（包括运行命令、读写文件）。默认关闭、随机令牌、
审批仍受 DSH 策略约束；详情见 [docs/SECURITY.md](dsh-remote-mobile/docs/SECURITY.md)。
请勿把令牌、`state.json`、签名文件或 `local.properties` 提交到仓库（`.gitignore` 已排除）。

## License

插件代码为 MIT（`dsh-remote-mobile/package.json`）；`dsh-remote-mobile/vendor/ws` 为 MIT，保留其 LICENSE。
HarmonyOS App 代码的许可以仓库所有者声明为准。
