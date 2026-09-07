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
im:message.reaction:write
```

路径：开放平台 → 你的应用 → 权限管理 → 搜索「表情回复」→ 勾选「添加消息的
表情回复」→ 发布版本并等待生效。

没开也不会坏：`addReaction` 是 best-effort，权限不足时飞书返回非零 code，
桥接只记一条 warn 日志并退回原来的进度提示，不会让这一轮任务失败。这一点
有测试固定（见 `test/bridge/lark-reaction.test.ts`）。

### 为什么分两步做

最终答案目前是渲染在那张流式卡片里的。直接把卡片摘掉、只留表情，有可能把
结论一起弄丢——那是最坏的结果。所以先把表情能力单独做完并测好，再改运行
流程的呈现方式，确保结论有独立的投递路径。
