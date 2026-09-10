# 项目介绍素材

最后更新：2026-09-09。

## 一句话

DSH飞书Session控制让每个飞书聊天按需连接一个 DeepSeek Harness session：Web 会话默认独立，支持稳定
别名、回收站、永久删除以及半衔接/完整衔接切换。

## 核心差异

1. Web 创建 session 默认不向飞书推送。
2. 飞书首次消息自动创建独立 session。
3. `/use` 无历史回填，避免手机聊天被旧上下文淹没。
4. `/switch` 控制 Web/TUI 新回合是否抄送飞书。
5. `/detach` 解除连接而不删除 session。
6. `/delete` 与 `/purge` 分离回收站和永久删除。
7. 只镜像 DSH 原生审批，不增加插件级逐工具提权。
8. Web/飞书任一端批准同一原生请求即可。
9. DSH 停止即飞书离线，不提供离线接管或自动重启。

## 来源表述

推荐统一使用：

> 本项目是 PlutoKeating/dsh-lark-bot（AGPL-3.0）的 fork，由见川维护；在上游飞书桥接基础上新增
> DSH 0.1.2-rc.1 进程内适配、统一 session 生命周期、Web 管理和半/完整衔接。

不要使用“完全从零原创”“官方上游”或“唯一官方 dsh-lark-bot”等表述。

## 演示流程

1. Web 新建 session，证明飞书不收到消息。
2. 新群发消息，证明自动创建独立 session。
3. `/sessions` 查看别名、标题和当前对话。
4. `/use` 切换且不回填历史。
5. `/switch` 演示半衔接与完整衔接。
6. `/detach` 后继续在 Web 使用旧 session。
7. `/delete` 进入回收站，再由 Web 恢复。
8. 对测试 session 执行 `/purge` 二次确认。

## 安全提示

- 只从本项目仓库或明确的 npm 包安装；
- 本项目不分发 `.exe`；
- 不在截图、Issue 或演示视频中暴露 app secret、API key、用户 open_id 或私密 transcript。
