# 兼容矩阵与升级政策

机器可读单一事实源：`src/config/dsh-compat.ts`。

## 当前矩阵

| 组件 | 锁定版本 | 当前状态 |
| --- | --- | --- |
| DeepSeek Harness CLI | `0.1.2-rc.1` | 正式 `web` profile 正在运行 |
| `@deepseek-ai/dsh-sdk-client` | `0.1.2-rc.1` | 精确 pin |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | `0.1.2-rc.1` | 精确 pin |
| `@deepseek-ai/dsh-acp` | `0.1.2-rc.1` | 精确 pin |
| Node.js | `>=22.19.0` | `package.json#engines` |

截至 2026-09-09，类型检查以及 session 投影、命令、原生审批镜像和进程内升级的定向回归已经通过。
最终 `verifiedAt` 只在完成正式 profile 构建、热加载/重启和实体飞书验证后更新。

## 推荐运行路径

DSH 插件模式优先使用进程内 `host` adapter：

- 直接读取宿主 session 列表、标题和事件；
- 直接执行 create/trash/purge/rename；
- 不依赖浏览器认证 token；
- 不依赖外部 HTTP RPC 名称或 events mux 路由。

`web` adapter 保留为兼容路径。`sdk`、`acp` 与 `headless` 是独立 runtime adapter，不提供宿主 session
投影，不能作为 `/sessions`、`/use`、`/delete`、`/purge` 的数据源。

## 版本锁定规则

- DSH 仍是预发布版本，SDK client/server/ACP 使用精确版本，不用宽松范围；
- `package.json`、`pnpm-lock.yaml`、`src/config/dsh-compat.ts` 和 `dshWorkshop.compatibility` 必须一致；
- 本包不直接依赖多份 DSH tool scheduler；桥接工具在受控边界注册；
- 升级不得只改全局 DSH CLI，必须重新验证 host services、session 事件、审批和插件加载。

## 升级流程

1. 在独立 `DSH_HOME` 安装候选 DSH；
2. 更新 `src/config/dsh-compat.ts` 与精确依赖；
3. `pnpm install` 更新 lockfile；
4. 运行 `pnpm typecheck`、定向回归、`pnpm test`、`pnpm build`；
5. 运行 `pnpm compat:probe`；
6. 测试 Web 新 session 不连接飞书、飞书首次消息半衔接、`/switch`、`/detach`、删除生命周期与审批 OR；
7. 安装到正式 profile并热加载；失败再显式重启；
8. 更新 `verifiedAt` 和本文日期。

详细命令见 `docs/UPGRADE.md`。

## Windows 测试说明

Windows 未开启开发人员模式或没有“创建符号链接”权限时，目录 symlink 测试会报 `EPERM`。此外 NTFS
不提供与 POSIX 完全相同的 `0600` mode 位，因此对应断言在 Windows 上可能失败。实际 Windows 凭据安全
由 owner-only ACL 测试覆盖。

这些平台限制必须与业务回归分开报告，不能把它们误写成 session 或审批功能失败。

## 自动化

| 命令 | 用途 |
| --- | --- |
| `pnpm upstream:report` | 检查 DSH 上游版本和本地矩阵漂移 |
| `pnpm compat:probe` | 在临时 DSH 环境验证 runtime/adapter/审批契约 |
| `pnpm ci:local` | diff、类型、全测、构建与发布包检查 |
| `pnpm release:check` | `ci:local` + 上游一致性 + 兼容探针 |

当前探针的审批拒绝层是 `dsh-native-approval`。旧的插件级 `tool-approval`、权限策略预检和 Guardian 路径
已不属于兼容目标。
