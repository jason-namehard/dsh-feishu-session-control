# 升级与兼容策略

当前主要兼容目标：DeepSeek Harness npm 默认 `latest` 的 `0.1.5-rc.3`；同时保留 `0.1.2-rc.1` 兼容声明。最后核对日期：2026-09-24。`next` 的 `0.1.7-rc.2` 尚未通过全插件验收，不能直接用于正式 profile。

## 1. 原则

1. 先更新/确认 DSH 版本，再适配和更新插件。
2. 正式 `DSH_HOME` 与测试 `DSH_HOME` 可并存，验证完成前不要覆盖正式数据。
3. 本项目不包含 Guardian；升级不会启动接管进程或在 DSH 关闭后继续连接飞书。
4. 优先热重载；只有热重载失败才由用户通过托盘显式重启 DSH。
5. session、别名、回收站和 projection 状态必须跨插件更新保留。

## 2. 隔离验证新 DSH

测试 home 是另一套 DSH 数据根目录，而不是另一份 Windows 程序。示例：

```powershell
$env:DSH_HOME = 'E:\DeepSeekHarness\dsh-test-home'
dsh --version
dsh --profile web
```

隔离条件：

- 使用不同 `DSH_HOME`；
- 使用不同 Web 端口；
- 不要让正式和测试实例同时使用同一个飞书应用长连接；
- 不复制真实 API key 到仓库。

确认新版本兼容后再更新正式 DSH。`dsh-test-home` 可在所有验证结束后删除；本轮按用户要求暂时保留。

## 3. 本地源码更新流程

在项目目录执行：

```powershell
pnpm.cmd install
pnpm.cmd typecheck
pnpm.cmd vitest run test/session/projection-store.test.ts `
  test/session/projection-bridge.test.ts `
  test/commands/session-projection.test.ts `
  test/notify/approval-answerer.test.ts `
  test/upgrade/channel-runner.test.ts `
  test/upgrade/channel-update.test.ts
pnpm.cmd build
```

然后更新正式 profile 的本地 `file:` 依赖：

```powershell
$env:DSH_HOME = 'E:\DeepSeekHarness\dsh-home'
& 'C:\Users\<user>\AppData\Roaming\npm\dsh.cmd' plugin --profile web add `
  'file:E:/DeepSeekHarness/dsh-plugins/dsh-feishu-session-control'
```

`dsh-hot-installer` 会监视 profile manifest。再次 `plugin add` 或 `update` 后：

- 新包可加载：原插件卸载并热挂载新版本；
- 新包加载失败：尝试恢复旧依赖和旧挂载；
- 无 HMR 或回滚失败：日志明确提示需要重启。

当前 DSH `0.1.5-rc.3` 的 CLI 没有单独的 `dsh plugin reload` 命令；不要把不存在的命令写入运维流程。

## 4. `package.json` 与 `pnpm-lock.yaml`

profile 的 manifest 和 lockfile 必须指向同一个本地目录：

```yaml
dsh-lark-bot:
  specifier: file:E:/DeepSeekHarness/dsh-plugins/dsh-feishu-session-control
```

目录改名后只改 `package.json` 而不更新 lockfile，短期可能仍能运行，但下一次安装会出现 manifest/lockfile
不一致。解决方式是在对应 profile 重新执行一次插件安装或 `pnpm install`，让 pnpm 重建本地 file 依赖记录。

升级源码时还必须先 `pnpm build` 再安装 `file:` 依赖，并检查
`node_modules/dsh-lark-bot/dist/plugin.js` 存在且安装包版本与源码一致。pnpm 可能复用旧包缓存：只执行
`pnpm install --force` 或重复 `add` 并不总能更新本地包。测试环境已验证的恢复方式是在对应 profile 执行
`pnpm remove dsh-lark-bot`，随后重新 `pnpm add file:E:/DeepSeekHarness/dsh-plugins/dsh-feishu-session-control`；
重新核对 profile manifest、lockfile、安装包版本及插件入口。此操作不删除任何 session 数据。

正式 profile 当前应检查：

```text
E:\DeepSeekHarness\dsh-home\profiles\web\package.json
E:\DeepSeekHarness\dsh-home\profiles\web\pnpm-lock.yaml
```

## 5. 飞书内 `/upgrade`

`/upgrade` 的当前实现：

1. 检查目标版本；
2. 给管理员发送 owner-bound 确认卡；
3. 确认后由 `InProcessChannelUpdater` 在当前 DSH 进程中启动一个更新任务；
4. 同一时间只允许一个升级；
5. 成功或失败后向原 chat/thread 发送终态。

它不再写 Guardian handoff 文件，也不依赖独立 updater/guardian 接管飞书。更新动作若导致当前插件需要
重新挂载，由热安装器处理；失败时保留明确错误，用户再决定是否托盘重启。

## 6. 兼容探针

```powershell
pnpm.cmd compat:probe
```

探针检查 DSH runtime、adapter、原生审批和插件入口。审批拒绝的预期层是
`dsh-native-approval`，不再是旧的插件级 `tool-approval`。
在没有可用审批渠道的隔离 SDK profile 中，新版运行时会发送 `approval/decided: unavailable` 并拒绝提权，
探针仅接受拒绝或不可用两种安全结果；这不等同于真实 Web/飞书审批链通过，后者仍需实体验收。

## 7. 回滚

当前 fork 尚未以独立 npm 包发布，不应使用同名上游 npm 包回滚。升级前先备份源码、正式 profile 的
`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 和设置；本机若已有未提交改动，不能直接
`git restore` 覆盖。需要回滚时只反向应用本轮升级差异，恢复对应版本的全部 profile 文件及全局 CLI，
再执行 `pnpm install`、`pnpm build` 和本地 `file:` 插件安装。不能仅删除 overrides，也不要删除任何
DSH session 数据来回滚插件代码。

## 8. 验收清单

- DSH 版本为 `0.1.5-rc.3`（或经过兼容验证的 `0.1.2-rc.1`）；
- profile manifest 与 lockfile 都指向当前项目目录；
- `typecheck`、核心 session/审批/升级测试和 `build` 通过；
- Web 新 session 不向飞书推送；
- 飞书首次消息自动建立半衔接；
- `/switch` 的 half/full 行为符合定义；
- `/detach` 后 session 仍在 Web；
- `/delete` 进入回收站，`/purge` 永久删除；
- DSH 停止后飞书同步离线；
- 系统中不存在 Guardian 进程、启动项或状态文件。
