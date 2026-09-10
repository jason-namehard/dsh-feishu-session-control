<h1 align="center">DSH飞书Session控制</h1>

<p align="center">🌏 <a href="README_EN.md">English</a> · 📦 <a href="docs/PROJECT_IDENTITY.md">项目身份与来源说明</a></p>

<p align="center">
  <strong>让每个飞书聊天连接一个可控的 DSH session</strong><br>
  Web 会话默认独立 · 飞书会话按需连接 · 半衔接/完整衔接可切换
</p>

> **来源声明**：本项目是 [`PlutoKeating/dsh-lark-bot`](https://github.com/PlutoKeating/dsh-lark-bot)
>（AGPL-3.0）的 **fork**。飞书长连接、命令路由、审批与工作区骨架来自上游，其著作权及
> AGPL-3.0 义务继续适用。
>
> 本仓库由 **见川** 维护，新增了 DSH `0.1.2-rc.1` 进程内适配、跨工作空间会话别名、回收站与
> 永久删除、Web 会话管理面板、飞书会话半/完整衔接，以及“只镜像 DSH 原生审批”的统一审批链。
> 完整说明见 [`NOTICE.md`](NOTICE.md) 和 [`docs/PROJECT_IDENTITY.md`](docs/PROJECT_IDENTITY.md)。

## 项目定位

本项目把飞书/Lark 桥接、DSH session 远程控制和 Web 会话管理整合进一个包。npm/DSH 包名暂时保留
为 `dsh-lark-bot`，项目与仓库名称为 **DSH飞书Session控制 / dsh-feishu-session-control**。

- 通过飞书 WebSocket 长连接收发消息，不需要公网 IP、域名或内网穿透。
- 作为 DSH 插件在宿主进程中运行；支持 DSH `0.1.2-rc.1`。
- 不包含 Guardian，不接管已关闭的 DSH，也不会自动启动或自动重启 DSH。
- Web 创建的 session 默认与飞书无关；只有飞书主动创建或显式 `/use` 的 session 才建立连接。

## 会话行为

| 操作 | 结果 |
| --- | --- |
| Web 创建 session | 默认不连接飞书；Web 消息和审批留在 Web 内 |
| 飞书聊天首次发送普通消息 | 自动创建独立 DSH session，并以**半衔接**连接 |
| `/use 0909-1` | 当前聊天切换到目标 session，不回填历史，切换后为半衔接 |
| `/switch` | 用卡片选择半衔接或完整衔接 |
| `/detach` | 只解除飞书连接；DSH session 和 Web 数据继续保留 |
| 关闭 DSH | 飞书同步断开；插件不接管、不拉起 DSH |

**半衔接**：飞书发起的回合仍在电脑端完整显示，其最终结果返回飞书；之后若从 Web/TUI 单独发起新
回合，该回合的消息与回复不抄送飞书。

**完整衔接**：除飞书发起回合外，同一 session 中从 Web/TUI 发起的新消息和回复也抄送到当前飞书聊天。

## 快速开始

前置条件：Node.js ≥ 22、已安装 DeepSeek Harness、已配置模型与 API key，并准备一个飞书/Lark 自建应用。

```bash
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
cd dsh-feishu-session-control
corepack enable
pnpm install
pnpm build
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package file:/你的绝对路径/dsh-feishu-session-control
dsh --profile web
```

Windows 示例中的本地包参数可写为
`file:E:/Vibecoding-Mirasim/dsh-feishu-session-control`。`setup` 会把同一个整合包安装到桥接 profile 和
`web` profile。首次绑定可按终端二维码完成；已有应用也可通过 `DSH_LARK_APP_ID`、
`DSH_LARK_APP_SECRET` 和 `DSH_LARK_TENANT` 配置。

> 当前 fork 尚未以独立 npm 包发布。不要运行 `npx dsh-lark-bot@latest`，该名称指向上游项目。

更完整步骤见 [`docs/QUICK_START.md`](docs/QUICK_START.md)。

## 常用命令

| 命令 | 功能 |
| --- | --- |
| `/sessions` | 跨工作空间列出会话、`MMDD-N` 别名、名称、状态和“当前对话”标记 |
| `/new [名称]` | 新建 session；未提供名称时打开可空提交的命名卡 |
| `/use <别名>` | 连接已有 session，不回填历史 |
| `/switch` | 切换半衔接/完整衔接 |
| `/detach` | 解除当前飞书聊天与 session 的连接 |
| `/rename <别名> [名称]` | 重命名 session，并同步到 DSH Web UI |
| `/delete <别名>` | 二次确认后移入回收站；别名不重排 |
| `/purge <别名>` | 二次确认后永久删除；不可恢复 |
| `/mention on\|off\|default [chatId]` | 设置本群或指定群是否必须 `@` 机器人才响应 |
| `/status` | 查看当前 scope、session、连接与任务状态 |
| `/upgrade` | 管理员确认后在当前 DSH 进程内执行更新 |

完整命令由 `/help` 返回；会话细节见 [`docs/SESSION_MANAGEMENT.md`](docs/SESSION_MANAGEMENT.md)。

## 审批原则

插件**不再增加逐工具审批或自定义权限门**。只有 DSH 本身决定需要批准时，插件才把同一个审批请求
同步到飞书：

- Web 与飞书看到的是同一请求；
- 任一端批准即可继续（OR 关系）；
- 飞书未连接的 Web session 不会被强制推送到飞书；
- 危险操作和真实方案选择仍由 DSH 原生策略决定是否询问。

这意味着 `pwsh`、`write` 等工具不会因为“来自飞书”而额外多一层批准。

## 群聊

一个普通群聊默认对应一套共享 session。首次消息自动创建，之后只处理新事件，不会轮询并重复注入全部
群历史。若要不 `@` 也响应，需要在飞书开放平台给应用身份开启敏感权限
`im:message.group_msg`，并用 `/mention off` 配置该群；少数群可用 `/mention on` 恢复为必须 `@`。

## Web 会话管理

整合面板提供归档、恢复、回收站、永久删除、详情、收藏和跨工作空间移动。Web 只在回收站内显示“彻底
删除”；飞书保留 `/purge <别名>`，并始终要求二次确认。

## 开发与验证

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Windows 未开启“开发人员模式”时，少数依赖目录符号链接的测试会因 `EPERM` 失败；POSIX `0600` 权限位
断言在 Windows 也不适用。核心 session、审批与进程内升级测试不依赖这些平台能力。

## 许可

- 主许可证：[`LICENSE`](LICENSE)（GNU AGPL-3.0）
- 上游与第三方说明：[`NOTICE.md`](NOTICE.md)
- `dsh-sessions-manager` MIT 许可：[`THIRD_PARTY_LICENSES/dsh-sessions-manager-MIT.txt`](THIRD_PARTY_LICENSES/dsh-sessions-manager-MIT.txt)
