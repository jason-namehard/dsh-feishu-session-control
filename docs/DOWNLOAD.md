# 下载与安装说明

最后核对日期：2026-09-09。

## 当前正式来源

| 项目 | 地址 / 说明 |
| :--- | :--- |
| 本项目 GitHub 仓库 | <https://github.com/jason-namehard/dsh-feishu-session-control> |
| 上游来源 | <https://github.com/PlutoKeating/dsh-lark-bot>（AGPL-3.0 fork 基础） |
| 当前交付方式 | Git 源码 + DSH 本地 `file:` 插件安装 |
| npm 状态 | 尚未以本项目独立包名发布 |

## 安装

```powershell
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
Set-Location dsh-feishu-session-control
corepack enable
pnpm install
pnpm build
$packagePath = 'file:' + ((Resolve-Path .).Path -replace '\\', '/')
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package $packagePath
```

然后启动承载 Web UI 与飞书连接的 profile：

```powershell
dsh --profile web
```

不要运行 `npx dsh-lark-bot@latest`。本项目为了兼容 DSH 暂时保留内部包名 `dsh-lark-bot`，但该 npm
名称仍指向上游项目，不会安装本 fork。

## 更新

```powershell
git pull --ff-only
pnpm install
pnpm typecheck
pnpm build
$packagePath = 'file:' + ((Resolve-Path .).Path -replace '\\', '/')
dsh plugin --profile web add $packagePath
```

优先让 `dsh-hot-installer` 热加载；若日志明确提示需要重启，再从托盘选择“重启 DSH”。

## 发布资产

当前仓库没有独立 npm 发布，也不提供所谓“下载即运行”的第三方安装器。将来若发布 tarball 或其他资产，
必须由本项目 GitHub Releases 提供并附 SHA-256 校验值；在此之前，以仓库源码为唯一正式交付物。

## 安全核对

- 仓库所有者应为 `jason-namehard`，项目名应为 `dsh-feishu-session-control`；
- README 第一屏应明确说明它是 `PlutoKeating/dsh-lark-bot` 的 AGPL-3.0 fork；
- 不要把飞书 App Secret、模型 API key、真实 `.env` 或 DSH 凭据提交到仓库；
- 来源不明的 exe、安装向导、压缩包或要求上传凭据的页面均不可信。

上游历史假冒事件的存档仅用于来源追溯，见
[`docs/security/2026-08-17-impostor-repo-evidence/`](security/2026-08-17-impostor-repo-evidence/README.md)。
