# 功能总览

当前版本面向 DSH `0.1.2-rc.1`。最后核对日期：2026-09-09。

## 飞书连接

- 飞书/Lark WebSocket 长连接，无需公网入口。
- 私聊、普通群聊和话题 scope。
- 群聊默认策略与逐群 `/mention on|off|default` 例外。
- 消息表情作为轻量“已收到”提示；默认不发送大进度卡、不展示 reasoning。
- 失败、超时、中断、审批和真实方案选择仍有明确终态。

## Session 控制

- 飞书首次普通消息自动创建独立 DSH session。
- Web 创建 session 默认不连接飞书。
- 跨工作空间 `/sessions` 与稳定 `MMDD-N` 别名。
- `/use` 无历史回填切换。
- `/switch` 在半衔接和完整衔接间切换。
- `/detach` 解除飞书连接但保留 DSH session。
- `/rename` 同步 DSH Web UI 标题。
- `/delete` 进入回收站；`/purge` 二次确认后永久删除。

## 半衔接与完整衔接

半衔接只把飞书发起回合的结果返回飞书；Web/TUI 独立发起的回合不抄送。完整衔接额外把同一 session
中的 Web/TUI 新消息和回复抄送到飞书。

首次自动连接和 `/use` 默认半衔接，只有 `/switch` 的明确选择才启用完整衔接。

## Web 会话管理

整合自 `dsh-sessions-manager` 的 Web 面板提供：

- 会话详情和原生标题；
- 归档与恢复；
- 回收站与恢复；
- 回收站内永久删除；
- 收藏、批量操作和跨工作空间移动。

使用者无需再单独安装会话删除或管理插件。

## 统一审批

- 插件不按 `pwsh`、`write` 等工具名自行提权。
- 插件不提供 `/permission ask|allow|deny`。
- 只有 DSH 原生 `approval/request` 会同步到飞书。
- Web 或飞书任一端批准即可继续。
- 真实的计划分歧可使用计划确认卡；普通工具调用不经过计划卡。

## 工作空间与任务

- 每个 scope 可选择工作空间并使用 Git worktree 隔离。
- 同一 scope 支持可配置并发数。
- 持久任务账本用于崩溃后的任务状态对账和显式 `/jobs retry`。
- 会话消息可按保留策略归档。
- 支持角色、执行模式、模型配置、跨会话通知和结果文件发送。

任务账本不代表离线接管：DSH 停止后飞书也停止。重新启动后，用户可查看和显式重试未完成任务。

## 更新与诊断

- `/version` 检查当前与最新版本。
- `/upgrade` 经管理员确认后执行进程内更新。
- `/doctor` 生成脱敏诊断信息。
- `dsh-hot-installer` 监听 profile manifest，负责插件 add/update 后的热挂载或回滚。

## 明确移除

当前项目已移除：

- Guardian 常驻进程；
- DSH 下线后的飞书接管；
- DSH 自动启动或自动重启；
- `/safemode`；
- 插件级逐工具 preflight/approval gate；
- `permission-policies.json` 和 `/permission`。

系统托盘只是本机显式启动、打开、重启和退出 DSH 的用户界面，不属于插件，也不承担 Guardian 功能。
