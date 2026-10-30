# API 与行为契约

本文记录 `dsh-feishu-session-control` 对 DSH `0.1.5-rc.3` 暴露的稳定集成面；同时保留对
`0.1.2-rc.1` 的兼容声明。最后核对日期：2026-09-24。

## 1. 包入口

`package.json` 保留兼容包名 `dsh-lark-bot`，主要 exports：

| 子路径 | 用途 |
| --- | --- |
| `dsh-lark-bot/plugin` | DSH 宿主插件；在进程内启动飞书桥接 |
| `dsh-lark-bot/session-manager` | 集成 Web session 管理面板 |
| `dsh-lark-bot/notify` | `lark_notify` 跨聊天通知工具 |
| `dsh-lark-bot/file` | 结果文件发送工具 |
| `dsh-lark-bot/ask` | 飞书用户问题回调 |
| `dsh-lark-bot/plan` | 真实方案选择的确认卡 |
| `dsh-lark-bot/approval` | DSH 原生审批的飞书镜像回答器 |
| `dsh-lark-bot/secret` | 本地凭据表单回调 |
| `dsh-lark-bot/skill` | 模型可见的飞书渠道说明 |

`cordis.patch.yml` 把这些入口装入 DSH profile。插件没有 Guardian 入口，也不注册 `/safemode` 或
`/permission`。

## 2. Session 投影存储

定义位于 `src/session/projection-store.ts`。

```ts
type FeishuConnectionMode = 'half' | 'full';

interface SessionProjectionBinding {
  scope: string;
  workspaceCwd: string;
  sessionId: string;
  chatId: string;
  threadId?: string;
  connectionMode: FeishuConnectionMode;
  lastProjectedSeq: number;
  pendingHistoryThroughSeq?: number;
  activeTurn?: { turn: string; feishuOrigin: boolean };
  recentMessages: ProjectedMessage[];
  promptCorrelations: PromptCorrelation[];
  boundAt: string;
  generationId: string;
}
```

### `SessionProjectionStore`

| 方法 | 契约 |
| --- | --- |
| `load()` | 读取持久状态；旧记录缺少模式时按 `half` 归一化 |
| `get(scope, cwd)` | 返回当前聊天/工作空间连接的副本 |
| `ownerOf(sessionId)` | 返回 session 的唯一飞书所有者 |
| `list()` | 返回全部连接副本 |
| `bindExclusive(input)` | 原子建立唯一连接；可校验旧 owner 防止确认卡过期后误迁移 |
| `setConnectionMode(scope, cwd, mode)` | 修改半/完整衔接 |
| `remove(scope, cwd)` | `/detach` 使用；只移除连接 |
| `removeSession(sessionId)` | session 删除后清除所有投影记录 |
| `advance(input)` | 持久推进 DSH 事件游标和当前回合状态 |
| `recordCorrelation(...)` | 关联飞书消息与 DSH RPC，识别飞书发起回合 |

持久文件为 `profiles/<profile>/session-projections.json`。

## 3. Session 投影源

接口位于 `src/session/projection-protocol.ts`。当前生产实现：

- `HostSessionProjectionSource`：直接调用 DSH 宿主 services；推荐路径；
- `WebSessionProjectionSource`：兼容旧的本机 Web RPC；
- `sdk`、`acp`、`headless` adapter：不提供 DSH 宿主 session 列表，因此不支持 `/sessions` 等投影命令。

核心操作：

```ts
interface SessionProjectionSource {
  listSessions(): Promise<DshSessionSummary[]>;
  createSession(workspaceCwd: string): Promise<string>;
  deleteSession(sessionId: string): Promise<SessionTrashResult>;
  purgeSession(sessionId: string): Promise<SessionPurgeResult>;
  renameSession(sessionId: string, title: string): Promise<string>;
  events(sessionId: string, afterSeq: number): Promise<DshSessionEvent[]>;
  subscribe(onEvent: (event: DshSessionEvent) => void): Promise<Disposable>;
}
```

## 4. Session 命令控制器

`src/commands/session-projection.ts` 的 `SessionProjectionController` 处理：

| 方法 | 对应行为 |
| --- | --- |
| `handleAliasCommand()` | `/sessions`、`/use`、`/delete`、`/purge` |
| `handleRenameCommand()` | `/rename` |
| `createNewSession()` | `/new` 创建原生 DSH session 和稳定别名 |
| `connectFeishuTurn()` | 首条飞书普通消息自动半衔接，并记录回合来源 |
| `handleConnectionCommand()` | `/switch`、`/detach` |
| `handleAction()` | 处理 session 相关确认卡、命名表单和模式卡片 |
| `current()` | 返回当前聊天/工作空间的连接 |

所有破坏性卡片都绑定 `actorId + scope + chatId + threadId + workspaceCwd + nonce`，默认 10 分钟过期。

## 5. 飞书命令

### `/sessions`

- 从 DSH 宿主获取跨工作空间 session；
- 同步 `.session_aliases.json`；
- 输出别名、DSH 原生标题、运行/回收站状态；
- 结合 projection store 和 run-flow session map 标记“当前对话”；
- 只发送一份列表，不再重复中英文两张相同内容。

### `/use <MMDD-N>`

- 不允许绑定回收站 session；
- 发送 owner-bound 确认卡；
- 确认后不回填历史；
- 连接模式设置为 `half`；
- 同一 session 的跨 scope 迁移仅管理员可执行。

### `/switch`

发送模式选择卡：

- `half`：仅飞书发起回合返回飞书；
- `full`：Web/TUI 新回合也抄送飞书。

### `/detach`

删除当前连接和 scope 的 session 指针，不删除 DSH session。下一条飞书普通消息会创建一个新的独立
session。

### `/new [name]`

创建 DSH session、注册别名并以半衔接连接当前聊天。未提供名称时发送可空提交表单；空值表示保留 DSH
自己的命名规则。

### `/rename <alias> [name]`

有名称时直接更新；无名称时打开输入卡。最终调用 DSH 原生重命名接口，因此 Web UI 与飞书使用同一标题。

### `/delete <alias>` 与 `/purge <alias>`

- `/delete`：二次确认后进入回收站，保留别名；
- `/purge`：二次确认后永久删除并移除别名；
- 成功、取消或失败后均发送终态并撤回原确认卡。

## 6. 原生审批镜像

`src/notify/approval-answerer.ts` 的 Cordis hook：

```ts
ctx.on('approval/request', async (request, next) => {
  // 并行等待 Feishu bridge 与 DSH Web 原生审批
  // 任一端 allowed-once 即返回 allowed-once
});
```

重要约束：

- hook 只在 DSH 已发出 `approval/request` 后运行；
- 不监听 `tools/pre-execute`；
- 不按工具名自行判断风险；
- 不保存 `ask/allow/deny` 工具策略；
- `pwsh`、`write`、`read` 等不会被插件额外拦截。

拒绝层仅用于解释 DSH 本身的结果：`dsh-native-approval`、`plan-gate`（显式计划选择）或
`file-sandbox`。

## 7. 进程内升级

`InProcessChannelUpdater.start(targetVersion, route)` 返回：

```ts
type StartChannelUpdateResult =
  | { accepted: true; id: string }
  | { accepted: false; reason: 'busy'; id: string };
```

更新任务在当前进程中异步执行，完成后调用 `complete()` 发送结果。任何时刻只允许一个更新任务。
`ChannelUpdateController` 负责管理员身份、确认卡 owner、offer 过期和目标版本固定。

## 8. 环境变量

常用配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_LARK_ADAPTER` | `web` | `host` 由 DSH 插件注入；手动运行可选 web/sdk/acp/headless |
| `DSH_LARK_WEB_URL` | `http://127.0.0.1:3080` | web adapter 地址 |
| `DSH_LARK_SESSION_PROJECTION` | `1` | 启用 session 列表与连接控制 |
| `DSH_LARK_SHOW_THINKING` | `0` | 飞书是否显示 reasoning |
| `DSH_LARK_PROGRESS_CARD` | `0` | 是否用大进度卡；默认仅表情确认 + 最终结果 |
| `DSH_LARK_GROUP_NO_AT` | `false` | 启用旧式无 @ 历史轮询兜底 |
| `DSH_LARK_GROUP_POLL_MS` | `3000` | 轮询间隔；事件权限生效后建议 `0` |
| `DSH_LARK_NOTIFICATION_DEFAULT` | `off` | 主动通知默认策略 |
| `DSH_LARK_DISABLED` | `0` | `1` 时插件加载但不启动飞书引擎 |

完整模板见 [`.env.example`](../.env.example)。

## 9. 明确不存在的接口

当前版本不提供：

- `guardian install/status/run/uninstall`；
- `/safemode`；
- `/permission`；
- Guardian 心跳、接管状态或更新交接文件；
- 飞书插件自定义的逐工具 preflight/approval gate。
