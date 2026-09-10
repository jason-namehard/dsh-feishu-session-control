---
layout: home

hero:
  name: DSH飞书Session控制
  text: 用飞书按需连接和管理 DSH Session
  tagline: Web 会话默认独立；飞书首次消息创建专属 session；半衔接与完整衔接可随时切换。
  image:
    src: /logo.svg
    alt: DSH飞书Session控制
  actions:
    - theme: brand
      text: 快速开始
      link: /guide/quickstart
    - theme: alt
      text: 命令速览
      link: /guide/commands

features:
  - icon: 🔗
    title: 按需连接
    details: Web 创建的 session 默认与飞书无关；飞书首次消息自动建立独立半衔接。
  - icon: 🔀
    title: 半/完整衔接
    details: 半衔接只返回飞书发起回合；完整衔接还会抄送同 session 的 Web/TUI 新回合。
  - icon: 🗂️
    title: 跨空间会话管理
    details: 稳定别名、当前聊天标记、重命名、回收站和二次确认永久删除集中管理。
  - icon: ✅
    title: 原生审批镜像
    details: 插件不增加工具权限门，只同步 DSH 原生审批；Web 或飞书任一端批准即可。
  - icon: 💬
    title: 私聊与群聊
    details: 每个聊天连接一套 session；群聊可按群设置是否必须 @ 机器人。
  - icon: 🌐
    title: 长连接
    details: 使用飞书 WebSocket 事件流，不需要公网 IP、域名或内网穿透。

---

::: warning 来源声明
本项目是 [PlutoKeating/dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot)（AGPL-3.0）的 fork，
由 **见川**维护。当前仓库为
[jason-namehard/dsh-feishu-session-control](https://github.com/jason-namehard/dsh-feishu-session-control)。
:::

## 安装

```bash
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
cd dsh-feishu-session-control
pnpm install
pnpm build
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package file:/absolute/path/to/dsh-feishu-session-control
dsh --profile web
```

本 fork 尚未以独立 npm 包发布；不要使用 `npx dsh-lark-bot@latest`，该名称指向上游项目。

## 开始阅读

- **[快速开始](/guide/quickstart)** — 源码安装、飞书权限和首次验证
- **[核心功能](/guide/features)** — 会话连接、管理与审批模型
- **[命令速览](/guide/commands)** — 常用 `/` 命令
- **[配置](/guide/configuration)** — 环境变量、profile 与群聊策略
- **[安全与权限](/guide/security)** — 来源、凭据和审批边界
- **[排障与 FAQ](/guide/troubleshooting)** — 常见问题与定位方式
