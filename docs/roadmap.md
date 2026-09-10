# 路线图

最后更新：2026-09-09。

## 已完成

- DSH `0.1.2-rc.1` 进程内宿主适配；
- 单包 Web session 管理；
- 稳定别名与跨工作空间 `/sessions`；
- session 创建、切换、重命名、回收站和永久删除；
- 半衔接、完整衔接和 `/detach`；
- 飞书移动端安静输出；
- 群聊无需 `@` 的事件流与逐群例外；
- DSH 原生审批 Web/飞书 OR；
- Guardian、`/safemode` 和插件级逐工具权限门移除；
- 进程内 `/upgrade`。

## 近期

- 完成正式 profile 部署后的实体回归；
- 把兼容矩阵 `verifiedAt` 更新到最终验证日期；
- 收敛 Windows symlink/POSIX mode 测试的跨平台表达；
- 发布前检查 README、NOTICE、包元数据和构建产物一致性。

## 非目标

- DSH 下线后继续回复飞书；
- 自动启动或自动重启 DSH；
- 每轮注入完整飞书群历史；
- 在飞书插件内复制一套独立于 DSH 的工具权限系统。
