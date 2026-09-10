# DeepSeek Harness 接入飞书：当前教程

最后更新：2026-09-09。

本教程已合并到：

- [`QUICK_START.md`](QUICK_START.md)
- [`SESSION_MANAGEMENT.md`](SESSION_MANAGEMENT.md)
- [`../README.md`](../README.md)

最短流程：

```bash
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
cd dsh-feishu-session-control
pnpm install
pnpm build
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package file:/absolute/path/to/dsh-feishu-session-control
dsh --profile web
```

当前 fork 尚未以独立 npm 包发布；`npx dsh-lark-bot@latest` 指向上游项目，不适用于本教程。

飞书首次普通消息会创建独立 session；使用 `/sessions`、`/use`、`/switch` 和 `/detach` 管理连接。
当前版本没有 Guardian 或 `/safemode`，停止 DSH 后飞书同步离线。
