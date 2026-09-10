# 快速开始

适用版本：DSH `0.1.2-rc.1`；最后核对日期：2026-09-09。

## 1. `dsh-home` 是什么

`DSH_HOME`（口头常称 `dsh-home`）是 DeepSeek Harness 的数据根目录，不是程序安装目录。它通常包含：

- DSH profiles 及每个 profile 的 `package.json`、`pnpm-lock.yaml`；
- 已安装插件和依赖；
- DSH 设置、凭据引用、session 与运行状态；
- Web profile 的组成方式。

更换或删除 `DSH_HOME` 等于让 DSH 使用另一套“用户数据”。同一台电脑可以保留测试 home 和正式 home，
只要启动时明确设置不同的 `DSH_HOME`；不能让两个实例同时占用同一飞书应用长连接或同一 Web 端口。

## 2. 前置条件

- Node.js 22 或更高版本；
- 已安装 `@deepseek-ai/dsh`；
- DSH 已配置模型和 API key；
- 一个飞书/Lark 自建应用；
- 飞书采用“长连接接收事件/回调”。

确认 DSH 版本：

```bash
dsh --version
```

## 3. 安装

当前 fork 尚未以独立 npm 包发布，应从本仓库源码安装：

```powershell
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
Set-Location dsh-feishu-session-control
corepack enable
pnpm install
pnpm build
$packagePath = 'file:' + ((Resolve-Path .).Path -replace '\\', '/')
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package $packagePath
```

`setup` 默认把同一个本地包装入桥接 profile 和 `web` profile。整合包已经包含 Web session 管理面板，
不再额外安装 `dsh-sessions-manager`、`dsh-plugin-session-delete` 或 Guardian。

不要运行 `npx dsh-lark-bot@latest`：这个 npm 名称目前仍属于上游项目，不会安装本 fork。

## 4. 飞书应用配置

最小配置需要机器人收发消息、卡片交互和长连接事件。推荐额外开启：

| 应用身份权限 | 用途 |
| --- | --- |
| `im:message.group_msg` | 接收群内不 `@` 机器人的消息 |
| `im:message.reactions:write_only` | 用表情表示“已收到，正在处理” |

权限应选择**应用身份权限**，因为桥接以自建应用/机器人身份连接，不是以某个用户授权身份运行。新增敏感
权限后需发布应用版本并等待生效。

已有应用可用环境变量绑定：

```text
DSH_LARK_APP_ID=cli_xxx
DSH_LARK_APP_SECRET=...
DSH_LARK_TENANT=feishu
```

未配置时，首次启动会打印二维码完成一次性绑定。

## 5. 启动

启动承载 Web UI 和飞书插件的 profile：

```bash
dsh --profile web
```

Windows 本机可用托盘脚本作为唯一入口：

```text
E:\DeepSeekHarness\启动DSH.bat
```

该脚本隐藏控制台、启动 DSH、打开带认证 token 的 Web 地址，并在通知区域显示图标。托盘提供打开、重启
和退出。退出 DSH 时飞书连接同步断开；不存在离线接管。

不要再单独启动旧桥接服务或另一个相同飞书应用实例，否则会出现两条 WebSocket 争抢同一事件流。

## 6. 首次验证

1. 在 Web 创建一个 session，发消息；飞书不应收到任何内容。
2. 在一个飞书私聊或群聊发送普通消息；DSH Web 应出现一个新 session，飞书收到最终结果。
3. 发送 `/sessions`；列表应显示当前对话标记。
4. 发送 `/switch`；切到完整衔接后，从 Web 发起一轮，飞书应收到抄送。
5. 再切回半衔接，从 Web 发起一轮，飞书不应收到抄送。
6. 发送 `/detach`；下一条普通消息应创建新的独立 session。

## 7. 群聊策略

普通群聊默认一群一套共享 session。只有新消息事件进入模型，不会在每轮重新注入群历史。

```text
/mention off       # 本群不用 @，每条新消息都响应
/mention on        # 本群必须 @ 才响应
/mention default   # 删除本群例外，回到全局默认
```

管理员也可指定 chatId：

```text
/mention on oc_xxxxxxxxx
```

若 `im:message.group_msg` 已生效，应设置 `DSH_LARK_GROUP_POLL_MS=0`，完全使用事件流。轮询不会直接把群
历史放入模型上下文，但会产生不必要的飞书 API 调用和去重工作。

## 8. Session 管理

```text
/sessions
/new [名称]
/use 0909-1
/switch
/detach
/rename 0909-1 新名称
/delete 0909-1
/purge 0909-1
```

`/delete` 进入回收站；`/purge` 永久删除。两个命令都必须点击二次确认。别名不会因为删除而重新编号。
完整说明见 [`SESSION_MANAGEMENT.md`](SESSION_MANAGEMENT.md)。

## 9. 审批验证

插件只镜像 DSH 原生审批。验证方式：

1. 在一个已连接飞书的 session 触发 DSH 确实需要的危险操作；
2. Web 和飞书应看到同一审批；
3. 任一端批准后任务继续；
4. 普通低风险工具不应被插件额外拦截。

如果 `pwsh` 仍被询问，先在 DSH 原生日志中确认是否存在 `approval/request`。有该事件表示 DSH 本身要求
审批；没有该事件却出现飞书卡，才属于插件问题。

## 10. 从旧 Guardian 版本迁移

当前版本不包含 Guardian。升级后应清理旧系统项：

- Windows 启动目录中的 `dsh-lark-guardian.vbs`；
- `~/.dsh-lark/guardian.json`；
- `~/.dsh-lark/profiles/<profile>/guardian/`；
- 旧的 guardian 后台进程或系统服务。

清理不会删除 DSH session。完成后关闭 DSH，飞书必须同步离线且不会自动重启。

## 11. 更新

飞书管理员发送 `/upgrade` 前，应先确认已显式配置本 fork 的更新来源。源码方式最稳妥的更新流程是：

```powershell
git pull --ff-only
pnpm install
pnpm typecheck
pnpm build
$packagePath = 'file:' + ((Resolve-Path .).Path -replace '\\', '/')
dsh plugin --profile web add $packagePath
```

更新后优先使用 DSH 插件热加载。若热加载失败，再从托盘显式“重启 DSH”。详见
[`UPGRADE.md`](UPGRADE.md)。

## 12. 卸载

```bash
dsh plugin --profile web remove dsh-lark-bot
dsh plugin --profile dsh-lark remove dsh-lark-bot
```

插件卸载不会自动删除 `~/.dsh-lark` 或工作区中的 `.session_aliases.json`，便于重新安装或人工备份。
