---
title: 排障与 FAQ
description: Session 连接、飞书事件、审批和本地部署的常见问题。
---

# 排障与 FAQ

## `/sessions` 找不到当前聊天

确认该飞书聊天已经发送过普通消息或成功执行 `/use <alias>`。首次普通消息会创建并连接 session；Web 创建的
session 默认不属于任何飞书聊天。

## 群里不 `@` 没反应

1. 确认已申请**应用身份权限** `im:message.group_msg`；
2. 在飞书开发者后台发布包含该权限的新版本；
3. 发送 `/mention off`；
4. 确认 `DSH_LARK_GROUP_POLL_MS=0` 时事件流确实已生效。

## `pwsh` 仍要求批准

先检查 DSH 原生日志是否存在对应 `approval/request`。存在表示 DSH 自身要求审批，插件只负责同步；Web 或
飞书任一端批准即可。不存在原生请求却收到飞书卡，才是插件额外审批问题。

## Web 消息为什么没有发到飞书

这是默认设计。Web session 默认不连接飞书；已连接 session 在半衔接下也不会抄送 Web/TUI 独立回合。使用
`/switch` 切到完整衔接后，才会抄送该 session 后续的电脑端新回合。

## 关闭 DSH 后飞书为什么离线

这是预期行为。本项目已完全移除 Guardian，不接管、启动或重启已关闭的 DSH。

## 更新后仍运行旧代码

重新执行本地 `file:` 插件安装，观察 `dsh-hot-installer` 日志。若热挂载失败或明确要求重启，再从系统托盘
选择“重启 DSH”。

## 诊断入口

- 飞书 `/status`：查看当前 scope、session 和衔接模式；
- 飞书 `/doctor`：生成脱敏诊断信息；
- DSH 主日志：确认 session、工具调用与 `approval/request`；
- `git status --short`、`pnpm typecheck`、定向 Vitest 与 `pnpm build`：验证源码工作区。
