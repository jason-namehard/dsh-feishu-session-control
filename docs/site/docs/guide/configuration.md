---
title: 配置
description: 飞书应用、DSH profile、会话衔接和群聊响应配置。
---

# 配置

## 常用环境变量

```text
DSH_LARK_APP_ID=cli_xxx
DSH_LARK_APP_SECRET=...
DSH_LARK_TENANT=feishu
DSH_LARK_ADAPTER=web
DSH_LARK_DSH_PROFILE=web
DSH_LARK_GROUP_NO_AT=true
DSH_LARK_GROUP_POLL_MS=0
```

- `DSH_LARK_ADAPTER=web`：使用 DSH Web host 的进程内 session 能力；
- `DSH_LARK_GROUP_NO_AT=true`：群聊默认不要求 `@`；
- `DSH_LARK_GROUP_POLL_MS=0`：已开通 `im:message.group_msg` 时只使用事件流，不轮询群历史。

完整模板见仓库 `.env.example`。

## 本地源码安装

```powershell
pnpm install
pnpm build
$packagePath = 'file:' + ((Resolve-Path .).Path -replace '\\', '/')
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package $packagePath
```

当前 fork 尚未以独立 npm 包发布；不要使用 `npx dsh-lark-bot@latest`。

## Profile 与数据目录

`DSH_HOME` 是 DSH 的数据根目录，包含 profiles、插件依赖、设置、凭据引用、session 与运行状态。正式环境与
测试环境可使用不同 `DSH_HOME` 隔离，但不能同时占用同一个飞书应用长连接或 Web 端口。

## 会话连接状态

飞书连接状态保存在插件 profile 的 projection 状态中：每条绑定记录包含飞书 scope、工作区、session ID、
聊天 ID 和 `half|full` 模式。`/detach` 只删除连接记录，不删除 DSH session。

## 群聊响应

```text
/mention off
/mention on
/mention default
```

也可由管理员指定 `chatId`。普通群聊默认整群共用一个 session，不按成员拆分。
