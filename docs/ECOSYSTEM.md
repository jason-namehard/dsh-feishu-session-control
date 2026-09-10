# 生态与来源

最后更新：2026-09-09。

## 当前项目

- 仓库：`jason-namehard/dsh-feishu-session-control`
- 维护者：见川
- 兼容包名：`dsh-lark-bot`
- 目标 DSH：`0.1.2-rc.1`

## 上游与第三方

| 项目 | 关系 | 许可处理 |
| --- | --- | --- |
| `PlutoKeating/dsh-lark-bot` | 本项目的 fork 基础 | 保留 Git 历史、版权和 AGPL-3.0 义务 |
| DeepSeek Harness | 宿主与 SDK/ACP 依赖 | 遵守其各自许可证 |
| `dsh-sessions-manager` | Web session 管理功能已整合 | 保留 MIT 许可证文本 |
| `dsh-hot-installer` | 可选热加载辅助插件 | 作为独立依赖使用，不复制为本项目原创 |

## 与早期“多插件拼盘”的区别

当前包内部统一了：

- 飞书 session 命令与 DSH 原生 session 生命周期；
- Web 归档、回收站和永久删除；
- 稳定别名与原生标题；
- host adapter、事件游标和飞书连接模式；
- DSH 原生审批在 Web/飞书的共同回答入口。

使用者不需要为了 session 管理再单独安装 `dsh-plugin-session-delete` 或 `dsh-sessions-manager`。

## 发布边界

本项目可以作为见川维护的新 fork 项目发布，但不能删除上游来源或声称全部代码从零原创。README 第一屏、
`NOTICE.md`、`LICENSE` 和第三方许可证共同构成公开归属说明。
