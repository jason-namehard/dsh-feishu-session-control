# 项目身份与来源说明 · Project Identity and Provenance

## 当前项目

- **正式名称**：DSH飞书session管理
- **维护者**：见川
- **本地项目目录**：`DSH-feishu-session`
- **GitHub 仓库**：待维护者确认最终的 GitHub 账号与仓库名后补入

本项目是一个独立发布的整合项目，目标是把 DeepSeek Harness、飞书/Lark WebSocket
桥接、远程 session 管理、Web 会话管理器和 Guardian 安全网合并到一个可安装的 DSH
扩展中。飞书端的 `/sessions`、`/use`、`/delete`、`/purge`、`/new` 与 Web 端的
归档、恢复、回收站和永久清理共用同一套 session 生命周期。

## 与上游项目的关系

本项目不是把几个插件并排安装，而是在现有开源实现基础上进行接口整合、代码迁移、
生命周期统一、适配器连接和测试补充。因此它可以作为“见川”维护的新项目发布，
但不能把保留的上游代码声称为从零独立编写。

当前 Git 历史保留上游提交作为来源链，并在其后追加本项目的整合提交。这不是 GitHub
仓库建设错误，也不会强制产生 Pull Request：只有向别人的仓库或上游仓库提交变更时
才需要 PR；将本地 `origin` 推送到自己拥有的新仓库通常直接推送即可。

## 许可证与署名

- 本项目整体许可证为 `AGPL-3.0`。
- 保留的上游实现继续遵守其原有版权和 AGPL 义务。
- 集成的 `dsh-sessions-manager` 部分保留 MIT 许可证文本，见
  `THIRD_PARTY_LICENSES/dsh-sessions-manager-MIT.txt`。
- 新增的整合代码、session 生命周期设计、适配器连接、飞书命令和测试由见川维护。

在最终 GitHub 地址确认前，不修改 `package.json`、`dsh-plugin.json` 和发布工作流中的
兼容包名及仓库 URL；这样不会破坏现有 `dsh-lark` profile。确认地址后，应在一个独立
提交中同步更新仓库元数据、README 链接、站点链接、插件 source 标识和发布配置。

## 文档分层

- 本文件：当前项目身份、来源和发布边界。
- `docs/SESSION_MANAGEMENT.md`：当前 session 整合功能与生命周期。
- `docs/SESSION_ALIASES.md`：飞书命令和别名行为。
- `docs/REQUIREMENTS.md`：从上游继承的历史需求档案，仅用于追溯，不再作为当前项目
  维护者或仓库身份的权威声明。
