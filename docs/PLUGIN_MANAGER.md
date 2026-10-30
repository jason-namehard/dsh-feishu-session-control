# 插件管家

当前仓库把插件管家作为 `dsh-lark-bot` 的第一方模块提供，不依赖 Claude、Hermes 或另一个插件管理插件。

## 能力

- 在 Web 设置的“插件”区域打开“插件管家”。
- 查看当前 profile 中每个 Loader 条目、模块名、版本、用途、启用状态和运行阶段。
- 停用或启用单个 Loader 条目；状态写入 profile 的 `cordis.patch.yml`，并通过 DSH Loader 热生效。
- 安全卸载 profile 插件；核心 DSH、Web、Loader、热安装器、当前 `dsh-lark-bot` 和插件管家受到保护。
- 安装插件时只接受精确的 registry `package@version`，禁用 npm 生命周期脚本，并检查 `dsh.bundle.patch`、YAML 列表和当前 DSH 兼容版本。
- 安装或卸载失败时同时回滚 `package.json`、`pnpm-lock.yaml` 和 workspace override，避免留下半安装状态。

## 安全边界

插件代码在 DSH Host 进程内运行，不能把任意 npm 包当成绝对安全的沙箱代码。因此安装表单要求确认包来源、权限声明和兼容版本；没有兼容声明的包会被拒绝。

插件管理路由只接受 loopback 请求，并校验浏览器 `Origin`。所有 profile 清单和用户 patch 写入都使用文件锁与原子替换，避免半写文件触发 DSH 重载。

## 生命周期

`dsh-hot-installer` 仍然是 profile 依赖和 bundle patch 的唯一热挂载协调者。插件管家只修改 profile 清单和用户 patch，不复制 Loader 生命周期实现：

1. 启停：更新用户 patch 的托管区块，再调用当前 Loader 条目的更新接口。
2. 安装：使用 `pnpm add --ignore-scripts --save-exact`，验证包后加入 `dsh.profile.bundles`。
3. 卸载：先从 `dsh.profile.bundles` 移除，再使用 `pnpm remove --ignore-scripts`。
4. 新增、卸载和依赖变更由 `dsh-hot-installer` 热挂载或热卸载；浏览器端 bundle 变更后刷新页面即可。

## 维护

Host 代码位于 `src/plugin-manager/index.ts`，浏览器界面位于 `src/plugin-manager/client.tsx`。发布前执行：

```powershell
pnpm.cmd typecheck
pnpm.cmd exec vitest run test/plugin-manager.test.ts
pnpm.cmd build
node tools/sync-to-profile.mjs
```

不需要保留诊断临时文件，也不需要修改 DSH 安装目录中的第三方源码。
