# 安全说明 · Security

最后核对日期：2026-09-09。

`dsh-feishu-session-control` 把本机 DeepSeek Harness 暴露给飞书/Lark。任何能向机器人发送受信消息的
用户，都可能间接驱动本机 coding agent；请把飞书访问控制视为本机权限边界的一部分。

## 官方项目身份

- 项目仓库：`jason-namehard/dsh-feishu-session-control`
- 兼容 npm/DSH 包名：`dsh-lark-bot`
- 维护者：见川
- 许可证：GNU AGPL-3.0；上游与第三方许可见 `NOTICE.md`

本项目是 `PlutoKeating/dsh-lark-bot` 的 fork，不代表上游作者。项目不提供 Windows/macOS 可执行安装
包；来源不明的 `.exe` 或“下载即运行”二进制不属于本项目分发物。

## 威胁模型

- 飞书 app secret、模型 API key、消息正文或工具参数泄露；
- 未授权私聊/群聊驱动本机工具；
- 卡片转发、重复点击、过期消息或重放事件造成误操作；
- 附件、工作空间和 worktree 路径逃逸；
- 外部 URL 造成 SSRF；
- 一个 DSH session 被多个飞书聊天争抢；
- 回收站与永久删除混淆造成不可恢复的数据丢失；
- Web 和飞书审批不一致造成卡死或重复批准。

## 访问控制

- `allowedUsers` 和 `allowedChats` 可限制可用用户与群聊；
- `DSH_LARK_ACCESS_DEFAULT_DENY=1` 可让未配置白名单时也拒绝私聊；
- 群聊 `/mention` 策略只能由管理员修改；
- `/use` 跨飞书 scope 迁移 session 仅管理员可执行；
- `/delete`、`/purge`、`/rename`、`/switch` 的卡片绑定原发起人和原 scope；
- member isolation 只隔离 agent 上下文，不隐藏群消息；敏感任务应使用私聊。

## Session 安全

- 同一个 DSH session 同时只能连接一个飞书 scope；
- `/use` 不发送已有 transcript，避免意外披露另一个 session 的历史；
- `/detach` 只移除连接，不删除 session；
- `/delete` 只进入回收站；
- `/purge` 永久删除，始终要求二次确认；
- 确认卡使用一次性 nonce，并校验 actor、scope、chat、thread、workspace、session 和 owner 变化。

## 审批安全

插件不增加按工具名判断的权限门，不提供 `/permission ask|allow|deny`，也不监听
`tools/pre-execute` 来阻止普通调用。

只有 DSH 原生 `approval/request` 会镜像到飞书。Web 和飞书是同一请求的两个回答入口，任一端
`allowed-once` 即继续；这不会绕过 DSH sandbox，也不会自动批准 DSH 已认定需要确认的危险操作。

审批卡可能包含工具名、理由和执行参数。群聊中这些内容对群成员可见；涉及密钥、私有路径或敏感命令时
应使用私聊或直接在 Web 处理。

## 凭据与日志

- `app_secret`、API key 和 token 不得提交到 Git；
- `.env.example` 只提供变量名和说明；
- 结构化日志对 secret/token/password/api_key 等字段脱敏；
- DSH 设置保存凭据引用，真实值应进入环境变量或 DSH 凭据存储；
- `/doctor` 只导出脱敏诊断，不应包含 transcript 或完整密钥；
- 飞书群内粘贴的密钥会被群成员看到，插件无法撤销这种披露。

## 文件与网络

- 附件、媒体和 worktree 路径必须通过 containment 检查；
- 文件摘要按 UTF-8 字节安全截断；
- 外部 URL 只允许安全的 HTTP(S) 公网地址，拒绝环回、私网、链路本地、CGNAT 和 IPv6 ULA；
- 消息时间戳超过 `DSH_LARK_EVENT_FRESHNESS_MS` 的事件会被拒绝；
- 入站消息 ID 和卡片 nonce 用于去重和防重放。

## 群聊

无需 `@` 响应需要应用身份权限 `im:message.group_msg`。即使飞书已经投递群消息，bridge 仍执行用户/群
白名单、mention policy 和 scope 鉴权。系统只处理新事件，不把整段群历史重复注入模型。

## 运行生命周期

项目不包含 Guardian：

- DSH 停止时飞书桥接停止；
- 不接管飞书连接；
- 不自动启动或重启 DSH；
- 不提供 `/safemode`；
- 不写 Guardian 心跳或接管状态。

可选 `service` 子命令是显式安装的普通用户后台服务，不是 Guardian。Windows 本机托盘同样只是用户主动
启动、打开、重启和退出 DSH 的界面。

## 本地数据

默认状态根目录为 `~/.dsh-lark`，可由 `DSH_LARK_HOME` 改写。敏感文件在 POSIX 上使用 owner-only
权限；Windows 使用当前用户 ACL。关键数据包括 access 配置、session 映射、投影连接、任务账本、归档
和通知渠道凭据。

工作区 `.session_aliases.json` 只保存别名和 sessionId，不包含 transcript。

## 报告漏洞

请通过本项目 GitHub Security Advisory 私下报告安全问题，不要在公开 issue 中提供可利用细节、密钥、
真实消息内容或本机路径。
