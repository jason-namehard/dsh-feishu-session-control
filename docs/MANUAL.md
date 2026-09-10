# 用户手册

适用版本：DSH `0.1.2-rc.1`。最后更新：2026-09-09。

## 1. 启动与停止

桥接作为 DSH profile 插件运行：

```bash
dsh --profile web
```

DSH 进程、Web UI 与飞书桥接属于同一运行生命周期。停止 DSH 后飞书同步离线；插件不会接管、重启或
保持一条额外连接。

Windows 本机使用 `E:\DeepSeekHarness\启动DSH.bat` 时，脚本启动隐藏托盘控制器。托盘可打开、重启或
退出 DSH。它是本机用户界面，不是 Guardian。

## 2. 飞书使用形态

### 私聊

同一个机器人只有一个私聊窗口，因此需要多个独立会话时，可在窗口内使用 `/new` 或 `/use`。当前聊天
只连接一个 session。

### 普通群聊

推荐“一群一 session”。群内所有人共享 DSH 上下文；若以后拉入其他成员，他们也能看到群里的任务输入和
回复。涉及隐私时应使用私聊。

### 话题

项目仍支持 topic/member 隔离，但普通群聊场景默认使用 `group`：整群共用一套 session。使用者不需要为
普通“一群一 session”配置 topic。

## 3. 消息与上下文

- 系统只处理飞书推送的新消息事件；
- 不会在每次请求前遍历并注入完整飞书历史；
- DSH 自己的 session transcript 会自然保留已经完成的上下文；
- `/use` 不把目标 session 的已有 transcript 回发飞书。

飞书消息发起的回合在 DSH Web 内完整显示。最终结果默认返回飞书；reasoning 默认不显示。

## 4. Session 命令

| 命令 | 说明 |
| --- | --- |
| `/sessions` | 跨工作空间列出别名、标题、状态和当前对话 |
| `/new [名称]` | 创建并连接新 session |
| `/use <别名>` | 确认后切换，不回填历史，模式为半衔接 |
| `/switch` | 用卡片切换半/完整衔接 |
| `/detach` | 解除飞书连接，保留 DSH session |
| `/rename <别名> [名称]` | 修改 DSH 原生标题并同步 Web UI |
| `/delete <别名>` | 二次确认后移入回收站 |
| `/purge <别名>` | 二次确认后永久删除 |
| `/resume` | 查看当前 session 的近期上下文摘要 |

详情见 `docs/SESSION_MANAGEMENT.md`。

## 5. 连接模式

### 半衔接

默认模式。飞书发起任务时，电脑端完整运行并把结果返回飞书；Web/TUI 独立发起的新回合不抄送飞书。

### 完整衔接

同一个已连接 session 中，Web/TUI 发起的新消息和回复也抄送飞书。适合离开电脑后仍希望手机持续看到
电脑端后续进展的情况。

`/switch` 只改变当前连接，不影响其他群聊或 session。

## 6. 审批与方案选择

### 工具审批

插件不增加工具权限层。DSH 本身没有请求审批时，飞书不会因为工具名是 `pwsh`、`write` 或 `read` 而
额外阻止。

DSH 原生请求审批时：

- Web 和飞书都可显示同一请求；
- 任一端批准即可；
- 飞书按钮使用短标签，完整选项正文按一行一个展示；
- 操作后卡片进入终态并撤回，避免重复点击。

### 方案选择

当 Agent 面临两个或多个真正不同的执行方案时，可发送正文列出完整 A/B/1/2 选项，并把短标签作为卡片
按钮。普通工具调用不应通过方案卡来索取权限。

## 7. 群聊无需 `@`

在飞书开放平台为应用身份开启 `im:message.group_msg`，发布版本后：

```text
/mention off       本群每条新消息都响应
/mention on        本群仅在 @机器人 时响应
/mention default   恢复全局默认
```

使用事件权限时建议设置：

```text
DSH_LARK_GROUP_POLL_MS=0
```

轮询只是旧权限环境的消息获取兜底，不会改善上下文质量。

## 8. 移动端输出

默认 `DSH_LARK_SHOW_THINKING=0`、`DSH_LARK_PROGRESS_CARD=0`：

- 收到消息后给原消息添加表情；
- 执行中保持安静；
- 完成后发送一条最终结果；
- 失败、超时或中断时发送简短终态；
- 审批、提问和方案选择仍使用交互卡片。

若表情权限不可用，bridge 只记录 warning，不应让任务失败。

## 9. Web 会话管理

设置/插件区域中的整合面板提供：

- 归档与恢复；
- 回收站与恢复；
- 回收站内永久删除；
- 详情、收藏、批量操作和跨工作空间移动。

飞书 `/delete` 对应回收站，`/purge` 对应永久删除。

## 10. 其他命令

| 类别 | 命令 |
| --- | --- |
| 工作空间 | `/cd`、`/ws` |
| 任务 | `/status`、`/jobs`、`/stop`、`/timeout`、`/concurrency` |
| 群隔离 | `/isolation`、`/mention` |
| 角色与模式 | `/role`、`/mode` |
| 配置 | `/config`、`/model`、`/provider`、`/key` |
| 通知 | `/notify`、`/notifications`、`/channels`、`/replies` |
| 运维 | `/version`、`/upgrade`、`/doctor` |

完整参数以飞书 `/help` 为准。

## 11. 常用环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_LARK_HOME` | bridge 状态根目录；不是 DSH 的 `DSH_HOME` |
| `DSH_LARK_APP_ID` / `DSH_LARK_APP_SECRET` | 飞书应用凭据 |
| `DSH_LARK_ADAPTER` | 手动运行 adapter；插件内优先 host |
| `DSH_LARK_WEB_URL` | web adapter 地址 |
| `DSH_LARK_SESSION_PROJECTION` | session 管理/连接功能开关 |
| `DSH_LARK_SHOW_THINKING` | 是否把 reasoning 发到飞书，默认关闭 |
| `DSH_LARK_PROGRESS_CARD` | 是否显示大进度卡，默认关闭 |
| `DSH_LARK_GROUP_POLL_MS` | 群历史轮询兜底；事件权限可用时设 0 |
| `DSH_LARK_NOTIFICATION_DEFAULT` | 主动通知默认策略，默认 off |
| `DSH_LARK_DISABLED` | `1` 时插件加载但飞书桥接不启动 |

完整变量见 `.env.example`。

## 12. 日志与诊断

桥接引擎使用 JSON Lines 写入 DSH 宿主日志。Windows 托盘启动的本机日志位于
`E:\DeepSeekHarness\dsh-home\logs\`。`/doctor` 可生成脱敏诊断；不要把真实 app secret、API key 或
完整私密 transcript 上传到公开 issue。

## 13. 卸载

```bash
dsh plugin --profile web remove dsh-lark-bot
dsh plugin --profile dsh-lark remove dsh-lark-bot
```

卸载不删除 DSH session、`~/.dsh-lark` 或工作区 `.session_aliases.json`。确认不再需要后再人工备份和
清理数据。
