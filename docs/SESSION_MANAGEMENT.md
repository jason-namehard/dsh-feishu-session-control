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

如果只需要飞书桥接而不需要复用 DSH Web 原生 session，保持默认 `sdk` adapter。
