---
title: 快速开始
description: 从源码安装 DSH飞书Session控制，并验证按需 session 衔接。
---

# 快速开始

## 前置要求

- Node.js ≥ 22；
- 已安装 DeepSeek Harness，并配置模型与 API key；
- 一个飞书/Lark 自建应用；
- 应用使用长连接接收事件与回调。

## 安装当前 fork

```powershell
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
Set-Location dsh-feishu-session-control
corepack enable
pnpm install
pnpm build
$packagePath = 'file:' + ((Resolve-Path .).Path -replace '\\', '/')
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package $packagePath
```

不要运行 `npx dsh-lark-bot@latest`，它会解析到上游 npm 包。

## 飞书权限

卡片交互需要启用 `card.action.trigger`。如果群聊希望不 `@` 也响应，还应申请应用身份权限
`im:message.group_msg`。用表情表示已收到需要 `im:message.reactions:write_only`。

## 启动

```powershell
dsh --profile web
```

Windows 正式环境可使用 `E:\DeepSeekHarness\启动DSH.bat`，由托盘统一打开、重启和退出 DSH。
DSH 停止后飞书同步离线；本项目没有 Guardian 或离线接管。

## 首次验证

1. 在 Web 新建 session 并发消息，飞书不应收到内容；
2. 在飞书发送普通消息，应自动创建独立 session 并返回最终结果；
3. `/sessions` 应显示当前聊天连接的 session；
4. `/switch` 切换完整衔接后，从 Web 发起一轮，飞书应收到抄送；
5. 切回半衔接后，从 Web 发起的新回合不应抄送；
6. `/detach` 后，原 session 保留，下一条飞书普通消息创建新 session。
