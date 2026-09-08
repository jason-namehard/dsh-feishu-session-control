# DSH飞书Session控制

本项目正式名称为 **DSH飞书Session控制**，npm/DSH 兼容包名仍为 `dsh-lark-bot`。

## 单包整合

一个 `dsh-lark-bot` 包现在包含：

- 飞书/Lark WebSocket 远程桥接；
- `MMDD-N` 稳定 session 别名、`/sessions`、`/use`、`/delete`、`/purge`、`/new`；
- DSH Web 会话管理面板；
- Web 端归档、恢复、回收站、永久清理、详情、收藏和跨工作区移动；
- `/__chameleon/session/delete` 兼容路由，供飞书 Web adapter 使用；
- Guardian 安全网守护。

不再需要单独安装 `dsh-sessions-manager`、`dsh-plugin-session-delete` 或
`dsh-archived-sessions`。Web 端整合代码及其 MIT 许可证位于
`src/integrated/session-manager/` 和 `THIRD_PARTY_LICENSES/`。

## 安装到两个 profile

飞书桥接运行在 `dsh-lark`，Web 会话管理面板运行在 `web`。推荐使用统一安装命令，自动把同一
项目包写入两个 profile：

```bash
npx dsh-lark-bot@latest setup --profile dsh-lark
```

等价的底层操作是：

```bash
dsh plugin --profile dsh-lark add dsh-lark-bot@<version>
dsh plugin --profile web add dsh-lark-bot@<version>
```

只安装桥接时使用 `setup --no-web`；非默认 Web profile 使用 `setup --web-profile <name>`。

在 Web profile 中，包只挂载会话管理能力，不启动第二个飞书桥接引擎。

## 生命周期

Web 管理器采用三层生命周期：

- **归档**：隐藏 session，可恢复；
- **删除**：进入回收站，可恢复；
- **永久清理**：从回收站彻底移除，不可恢复。

当前飞书 `/delete <MMDD-N>` 在二次确认后移入回收站，别名保留，便于后续恢复或永久清理。
`/purge <MMDD-N>` 在二次确认后永久清理，该操作不可恢复。Web 端仍提供回收站中的恢复、批量
操作和永久清理能力。

## Web adapter

`web` adapter 不是飞书连接方式，而是让桥接通过本机 DSH Web host 的 HTTP RPC
和 `/api/events.mux` WebSocket 续接原生 DSH session。使用前需要：

1. 启动 DSH Web profile；
2. 确认 Web host 地址可访问，默认是 `http://127.0.0.1:3080`；
3. 在 `dsh-lark-bot` 设置中选择 `web` adapter，并保存。

如果只需要独立的飞书桥接而不需要复用 DSH Web 原生 session，可显式设置 `DSH_LARK_ADAPTER=sdk`；
当前默认是 `web`，这样 Web 与飞书共享同一个 DSH session 写入者。

## 飞书进度提示：表情回复代替进度卡片

手机上一次任务原本会占掉一张不断刷新的大卡片，把真正要看的结论挤到很远。
目标形态是：**你的消息 + 一条结果**，中间不额外占位。

做法是给「你发的那条消息」加一个表情回复作为已读确认，不再发进度卡片：

- 收到消息 → 在你的消息上加 `OnIt` 表情（表示已看到、正在做）
- 执行中 → 不发任何消息
- 完成 → 清掉表情，发一条最终结果
- 出错或需要你决策 → 才发卡片

### 需要开的飞书权限

表情回复要一个额外权限，请在飞书开放平台为该应用开启：

```text
im:message.reactions:write_only    发送、删除消息表情回复
```

路径：开放平台 → 你的应用 → 权限管理 → 搜索「表情回复」→ 勾选「发送、删除
消息表情回复」→ 发布版本并等待生效。

注意权限码是复数 `reactions` 且后缀是 `write_only`，不是 `reaction:write`。

已实测（2026-09-07，真实应用凭据 + 真实会话）：拿 tenant token、列消息、
`POST /im/v1/messages/{id}/reactions` 加表情、`DELETE .../reactions/{rid}`
删表情，四步全部返回 `code=0`。测试用的表情已清理。

没开也不会坏：`addReaction` 是 best-effort，权限不足时飞书返回非零 code，
桥接只记一条 warn 日志并退回原来的进度提示，不会让这一轮任务失败。这一点
有测试固定（见 `test/bridge/lark-reaction.test.ts`）。

### 已生效

安静模式现在是默认行为，`DSH_LARK_PROGRESS_CARD=1` 可以换回进度卡片。

之所以能安全摘掉卡片：最终答案本来就有独立投递路径，它是用 `sendMarkdown`
单独发的，不只存在于卡片里。中间气泡被抑制后 `interim.delivered` 为空，于是
「尚未送出的尾巴」正好等于完整答案——一条消息，不是一串碎片。

失败路径需要额外处理：卡片原来负责显示错误，摘掉之后失败会变成**沉默**，
而沉默和「还在跑」在手机上完全无法区分——这恰恰是已读确认最不能造成的误解。
所以安静模式下非正常结束会补发一条简短消息（已中断 / 超时 / 执行失败）。

审批卡、提问卡、计划卡不受影响：它们本来就是独立消息，不走运行卡片。

## session 命令的数据来源（进程内）

`/sessions`、`/use`、`/delete`、`/purge` 需要 DSH 自己的会话列表。作为插件跑在
dsh 里时，这些数据直接从宿主服务读，不再走它自己的 HTTP API：

| 能力 | 来源 |
| :--- | :--- |
| 会话列表 | `sessionPersistence.list()`（含未 live 的会话） |
| 标题补全 | `sessionQuery.readTitleSnapshot()` |
| 运行中标记 | `ctx.sessions.list()` |
| 历史回填 | `sessionPersistence.readFrom()` |
| 实时事件 | `ctx.on('session/event')` |
| 发消息 | `agent.followup()` |
| 新建会话 | `ctx.agents.create()` |
| 回收站 / 彻底删除 | 本项目自己注册的 `/__chameleon/session/{delete,purge}` |

最后一行是刻意的例外：这两个路由不在 `/api` 前缀下，不受 dsh 的浏览器认证围栏
影响，在 0.1.2-rc.1 上依然可用；而回收站索引、墓碑记录和路径安全检查都集中在
`src/integrated/session-manager`，没必要再实现第二份。

只列 live 会话是不够的——用户切走的会话仍然可选，但已经不 live 了，所以列表以
持久化层的 header 为准。

回收站读不到时按空处理：丢掉一个 trashed 标记是可恢复的，把整个列表打空不是。

实测：DSH 启动后 `session-projection` 记录 `mux-connected`，无任何错误；此前这个
category 每 5 秒刷一次 `web mux websocket connection failed`。

## 飞书侧的权限与电脑端对等

DSH 在电脑端的会话设置是 `permission/preset: danger-full-access` +
`approval/policy: never`——它自己什么都不问。飞书侧之所以反复弹批准，是**桥接
额外加的 plan-gate**，不是 DSH 在拦。

`isHighRiskTool` 的判定范围包括 `run_code`、非简单 shell 命令、终端/diff 类
工具，以及 `edit` / `delete` / `move` / `execute` 类操作——几乎覆盖所有真正
干活的动作，所以一个多步任务会被打断很多次。

关掉它即可获得与电脑端对等的权限：

```text
DSH_LARK_PLAN_GATE=off
```

已写入 `启动DSH.bat` 和 `dsh-tray.ps1`，两条启动路径都生效。

需要清楚代价：这一层原本是为「手机丢了怎么办」准备的——飞书是远程入口，
gate 关掉后，任何能用你飞书的人就拥有和坐在这台电脑前一样的能力。这是
deployment 层面的取舍，不是代码缺陷。想恢复只需删掉那一行，或设为 `strict`。

工具层的策略拒绝（`checkPermissionPolicy`）不受影响，仍然生效。
