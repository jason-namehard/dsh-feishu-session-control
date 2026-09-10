---
title: 命令速览
description: DSH飞书Session控制的主要飞书命令。
---

# 命令速览

`/help` 返回当前构建的完整命令清单。下面列出与 session 控制直接相关的命令。

## Session 连接

| 命令 | 作用 |
| --- | --- |
| `/sessions` | 跨工作空间列出别名、标题、状态和当前聊天标记 |
| `/new [名称]` | 创建新 session；无名称时打开可空提交的命名卡 |
| `/use <别名>` | 当前聊天连接已有 session，不回填历史，并重置为半衔接 |
| `/switch` | 用卡片选择半衔接或完整衔接 |
| `/detach` | 解除当前飞书聊天连接，保留 DSH session |
| `/rename <别名> [名称]` | 重命名 session，并同步到 DSH Web UI |

## 生命周期

| 命令 | 作用 |
| --- | --- |
| `/delete <别名>` | 二次确认后移入回收站 |
| `/purge <别名>` | 二次确认后永久删除，不可恢复 |

## 群聊

| 命令 | 作用 |
| --- | --- |
| `/mention off` | 当前群每条新消息都可触发机器人 |
| `/mention on` | 当前群必须 `@` 机器人才触发 |
| `/mention default` | 删除当前群例外，恢复全局默认 |

管理员可在命令末尾指定 `chatId` 管理其他群。

## 运行与审批

| 命令 | 作用 |
| --- | --- |
| `/status` | 查看当前 scope、session、衔接模式与运行状态 |
| `/stop` | 终止当前任务 |
| `/doctor` | 生成脱敏诊断信息 |
| `/upgrade` | 管理员确认后执行已配置来源的进程内更新 |

插件不提供 `/session`，避免与跨工作空间 `/sessions` 重复；也不提供 Guardian 的 `/safemode`。
