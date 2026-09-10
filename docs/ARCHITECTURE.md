# 架构说明

本文描述 `dsh-feishu-session-control` 在 DSH `0.1.2-rc.1` 上的当前架构。最后核对日期：
2026-09-09。

## 1. 设计边界

系统遵循四条不可破坏的边界：

1. Web 创建的 session 默认与飞书无关。
2. 飞书只接收飞书发起回合的结果，除非用户显式切换到完整衔接。
3. 插件不创造工具审批；只镜像 DSH 原生审批，Web 或飞书任一端批准即可。
4. DSH 停止时飞书桥接同步停止；不存在 Guardian、离线接管或自动重启。

## 2. 运行拓扑

```text
┌──────────────────────────── DSH host process ────────────────────────────┐
│                                                                          │
│  DSH Web/TUI ───────────────┐                                            │
│                             ▼                                            │
│                    HostDshAdapter / HostServices                         │
│                             │                                            │
│  Feishu WebSocket ──> channel/run-flow ──> native DSH session            │
│           │                 │                     │                       │
│           │                 ├─ session alias      ├─ DSH event stream     │
│           │                 ├─ attachment mode    └─ native approval      │
│           │                 └─ result delivery            │               │
│           └───────────────────────────────────────────────┘               │
│                                                                          │
│  Integrated Web session manager: archive / recycle bin / purge / restore │
└──────────────────────────────────────────────────────────────────────────┘
```

生产路径优先使用 `host` 进程内适配：桥接直接调用 DSH 宿主服务，不再依赖浏览器认证、回环 HTTP RPC
或 `/api/events.mux` 的外部兼容面。`web` adapter 仍保留为兼容路径；`sdk`、`acp`、`headless` 用于独立
运行时，不提供宿主 session 投影。

## 3. 入站消息

飞书消息经 `src/bridge/channel.ts` 完成鉴权、群聊隔离、命令识别和卡片回调路由；普通消息进入
`src/bridge/run-flow.ts`。

普通消息第一次进入某个 scope 时：

1. 解析当前工作空间；
2. 创建或取得该 scope 的 DSH session；
3. `SessionProjectionController.connectFeishuTurn()` 以半衔接连接该 session；
4. 记录本次 DSH RPC 与飞书消息 ID 的相关性；
5. 运行任务并只把该飞书发起回合的结果返回原聊天。

系统只处理飞书推送的新消息事件。群历史轮询仅是旧权限环境的兼容兜底；取得
`im:message.group_msg` 后应把 `DSH_LARK_GROUP_POLL_MS` 设为 `0`，避免重复 API 调用。

## 4. Session 连接模型

`src/session/projection-store.ts` 持久化连接，而不是复制 DSH transcript。每条连接包含：

- 飞书 scope、chatId、可选 threadId；
- workspace 路径与 DSH sessionId；
- `half` 或 `full` 连接模式；
- DSH 事件游标、当前回合来源和远端消息关联信息。

同一个 DSH session 同一时间只允许归属一个飞书 scope。管理员可通过 `/use` 迁移；普通用户必须先在
原聊天 `/detach`。

### 半衔接

- 飞书发起的 user/assistant 回合返回飞书；
- Web/TUI 单独发起的后续回合不投影；
- 电脑端仍能看到飞书回合，因为真实执行始终发生在同一个 DSH session。

### 完整衔接

- 半衔接的行为全部保留；
- Web/TUI 发起的新消息及回复也投影到绑定的飞书聊天。

`/use` 和首次自动连接都显式设置 `half`；`/switch` 才能改成 `full`。`/detach` 删除连接和本地 scope
映射，但不删除 DSH session。

## 5. 不回填历史

`/use` 先读取目标 session 的当前事件序号，再建立连接并把游标推进到该快照。这样切换立即生效，但不会
把已有 transcript 发进飞书。启动恢复同样从持久游标继续，避免重复投影已确认消息。

## 6. 别名与生命周期

`src/session/alias-manager.ts` 在默认工作区的 `.session_aliases.json` 保存稳定的
`MMDD-N -> sessionId` 映射。同步 session 列表时只为未知 session 分配新别名；删除条目不会让其他编号
重排。

- `/delete` 调用 DSH 回收站能力，保留别名；
- `/purge` 永久删除后移除别名；
- `/rename` 修改 DSH 原生标题，因此 Web UI 与飞书显示同一名称；
- `/sessions` 从 DSH 宿主读取跨工作空间会话，并结合 run-flow 与连接存储识别“当前对话”。

## 7. 审批

`src/notify/approval-answerer.ts` 只监听 DSH 已经产生的 `approval/request`。收到请求后并行等待：

- `next()`：DSH Web/宿主的原生审批；
- 飞书审批卡：相同 session、tool、callId 的远端回答。

任一端先返回 `allowed-once` 即通过。一个端拒绝时仍等待另一个端；只有两端均未批准时才返回拒绝、取消
或不可用。插件已删除旧的逐工具 `pre-execute` 门、权限策略存储和 `/permission` 命令。

## 8. 交互卡片

`src/commands/session-projection.ts` 为 `/use`、`/delete`、`/purge`、`/rename` 和 `/switch` 保存带过期时间
的 nonce。卡片回调必须匹配发起人、scope、chat、thread、workspace 和目标 session，防止旧卡或转发卡
误操作。

操作完成后走“发送终态回复并撤回原卡”的稳定路径，避免飞书 SDK 的卡片 patch 返回非零业务码却不抛
异常，造成按钮看似仍可点击。

## 9. 进程内升级

`src/upgrade/channel-update.ts` 管理管理员专属的升级确认卡；
`src/upgrade/channel-runner.ts` 在当前 DSH 进程中串行执行一个升级任务，拒绝并发升级。升级完成后发送终态
结果。它不再把任务交给 Guardian 或独立接管进程。

如果更新后的插件需要重新装载，由 DSH 热加载机制执行；热加载失败时，操作者可通过托盘显式重启 DSH。

## 10. 本地状态

默认桥接状态根目录是 `~/.dsh-lark`，可由 `DSH_LARK_HOME` 改写。关键文件：

| 路径 | 内容 |
| --- | --- |
| `config.json` | profile、凭据引用、访问控制与偏好 |
| `profiles/<profile>/sessions.json` | 飞书 scope 到 DSH session 的运行映射 |
| `profiles/<profile>/session-projections.json` | 飞书连接模式和事件游标 |
| `<workspace>/.session_aliases.json` | 稳定 session 别名 |
| `profiles/<profile>/jobs.json` | 可恢复任务账本 |
| `profiles/<profile>/archives/` | 飞书侧会话消息归档 |
| `profiles/<profile>/workspaces.json` | 工作空间配置 |
| `service/<profile>.*` | 可选后台服务配置；不是 Guardian |

仓库和运行时均不再使用 `guardian.json`、`guardian/heartbeat.json` 或 `/safemode`。

## 11. 主要模块

| 目录 | 职责 |
| --- | --- |
| `src/bridge/` | 飞书事件、任务运行、结果发送和长连接健康监测 |
| `src/session/` | session 映射、别名、投影游标、归档 |
| `src/commands/` | 斜杠命令和交互卡片动作 |
| `src/notify/` | DSH 原生审批/提问/计划/文件回调 |
| `src/integrated/session-manager/` | 集成 Web 会话管理面板 |
| `src/adapters/dsh/` | host/web/sdk/acp/headless 适配 |
| `src/upgrade/` | CLI 与飞书内进程内升级 |
| `src/service/` | 可选的用户后台服务生命周期 |
