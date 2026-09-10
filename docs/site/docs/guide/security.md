---
title: 安全与权限
description: 项目来源、飞书权限、DSH 原生审批和凭据边界。
---

# 安全与权限

## 项目来源

本项目是 [PlutoKeating/dsh-lark-bot](https://github.com/PlutoKeating/dsh-lark-bot)（AGPL-3.0）的 fork，
由 **见川**维护。正式仓库是
[jason-namehard/dsh-feishu-session-control](https://github.com/jason-namehard/dsh-feishu-session-control)。

当前 fork 尚未以独立 npm 包发布。`npx dsh-lark-bot@latest` 指向上游，不是本项目安装入口。

## 飞书应用权限

- 卡片按钮与表单：启用 `card.action.trigger` 回调；
- 群聊不 `@` 也接收：申请应用身份权限 `im:message.group_msg`；
- 已读表情：申请应用身份权限 `im:message.reactions:write_only`。

敏感权限新增后必须发布新的飞书应用版本并等待生效。

## 工具审批

插件不设置 `ask|allow|deny` 形式的额外逐工具门禁，也不因命令是 `pwsh`、`write` 等而自行拦截。只有 DSH
原生运行时发出审批请求时，插件才把同一请求同步到飞书。Web 或飞书任一端答复即可完成该审批。

如果飞书出现审批卡，应在 DSH 日志中找到对应 `approval/request`。没有原生事件却出现卡片才属于插件问题。

## Session 边界

- Web 创建的 session 默认不连接飞书；
- 半衔接不会抄送电脑端独立回合；
- 完整衔接只抄送当前已连接 session 的新消息与回复；
- `/detach` 解除连接但保留 session；
- DSH 停止后飞书同步离线，没有 Guardian 或离线接管。

## 密钥与凭据

不要把飞书 App Secret、模型 API key、真实 `.env`、DSH 凭据文件或本机认证 URL 提交到 Git。诊断、日志与
卡片不得回显完整密钥。
