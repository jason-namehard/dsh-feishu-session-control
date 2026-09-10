# 项目身份与来源说明 · Project Identity and Provenance

最后核对日期：2026-09-09。

## 当前项目

- **正式名称**：DSH飞书Session控制
- **英文名称**：DSH Feishu Session Control
- **维护者**：见川
- **本地目录**：`dsh-feishu-session-control`
- **GitHub 仓库**：`jason-namehard/dsh-feishu-session-control`
- **兼容 npm/DSH 包名**：`dsh-lark-bot`
- **许可证**：GNU AGPL-3.0

包名暂时保留是为了不破坏已经安装到 DSH profile 的依赖和 Cordis patch，不代表本项目仍属于上游仓库。

## 与上游的关系

本项目是 `PlutoKeating/dsh-lark-bot`（AGPL-3.0）的 fork，保留了它的 Git 历史和一部分代码结构。飞书
长连接、命令路由、审批卡与工作区骨架来自上游；这些部分的原版权与 AGPL 义务继续有效。

本项目不是“从零原创”，也不是向上游提交的 PR。它是在合法 fork 基础上由见川维护的新仓库，可以直接
推送到自己的 `origin`。只有希望把改动合回上游时才需要 Pull Request。

## 本项目新增与重构

- DSH `0.1.2-rc.1` 进程内 host adapter；
- 跨工作空间 `MMDD-N` session 别名；
- `/sessions`、`/use`、`/switch`、`/detach`、`/rename`、`/delete`、`/purge`；
- Web session 管理器整合；
- 回收站与永久删除统一生命周期；
- Web session 默认不连接飞书；
- 半衔接/完整衔接投影；
- 只镜像 DSH 原生审批，Web/飞书任一端批准即可；
- 飞书移动端安静结果模式和逐群 mention policy；
- 进程内 `/upgrade`。

## 已明确移除

- Guardian 和安全模式接管；
- DSH 下线后继续占用飞书连接；
- 自动启动或自动重启 DSH；
- 插件级逐工具权限门和 `/permission`。

## 第三方代码

集成的 `dsh-sessions-manager` 功能保留 MIT 许可文本：
`THIRD_PARTY_LICENSES/dsh-sessions-manager-MIT.txt`。

完整版权与许可说明见仓库根目录 `NOTICE.md`。不得删除上游版权、许可证或 Git 历史来伪装为从零原创。

## Git 远程

推荐配置：

```text
origin   https://github.com/jason-namehard/dsh-feishu-session-control.git
upstream 仅用于只读追踪上游；禁止作为默认 push 目标
```

日常提交由维护者在本地 `main` 审核后推送到自己的 `origin`，不需要向上游发 PR。
