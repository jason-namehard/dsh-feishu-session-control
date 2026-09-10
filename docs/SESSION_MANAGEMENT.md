# Session 管理规范

最后核对日期：2026-09-09。

## 1. 三类状态

### DSH session

真实对话由 DSH 管理，包含 transcript、标题、工作空间、运行状态和回收站状态。插件不复制或改写其内部
存储，只通过 DSH 提供的服务读取和执行生命周期操作。

### 飞书 scope 映射

`sessions.json` 记录某个飞书 scope 在某个工作空间当前使用哪个 DSH session。首次飞书普通消息会创建
这一映射；Web 创建 session 不会创建它。

### 飞书连接

`session-projections.json` 记录 session 是否连接到某个飞书聊天、连接模式和事件游标。它决定 Web/TUI
事件是否抄送飞书，不决定 DSH session 是否存在。

## 2. 稳定别名

默认工作区根目录的 `.session_aliases.json` 保存：

```json
{
  "0909-1": "session-uuid-a",
  "0909-2": "session-uuid-b"
}
```

生成规则：

1. 使用本机日期 `MMDD`；
2. 查找同日前缀的最大序号；
3. 新别名使用 `max + 1`；
4. 删除别名后不复用、不重排其他编号。

已有 DSH session 第一次被 `/sessions` 同步时也会获得别名。

## 3. Web 与飞书的默认关系

### Web 创建

Web 创建的 session 默认完全独立：

- 不建立飞书 scope 映射；
- 不建立飞书连接；
- Web 消息和回复不发送到飞书；
- DSH 原生审批留在 Web，除非以后显式连接到某个飞书聊天。

### 飞书首次消息

一个尚未映射的飞书聊天发送普通消息时：

- 创建新的 DSH session；
- 注册稳定别名；
- 建立半衔接；
- 该消息在 DSH Web 内可见；
- 最终结果返回原飞书聊天。

## 4. `/sessions`

输出跨工作空间会话，格式包含：

- `MMDD-N` 别名；
- DSH 原生标题；
- 空闲、运行中或回收站状态；
- 当前聊天正在使用的 session；
- 当前连接为半衔接或完整衔接。

“当前对话”优先读取 projection 连接；若首次消息已运行但连接记录尚未由手工命令确认，则回退读取
run-flow 的 session 映射。这样新群聊首次对话后也能准确标出当前 session。

## 5. `/new [名称]`

`/new 项目排查`：立即创建并使用该标题。

`/new`：创建 session 后发送名称输入卡。允许空值提交：

- 非空：调用 DSH 原生 rename，同步到 Web UI；
- 空值：保留 DSH 的默认命名规则。

新 session 自动得到别名并以半衔接连接当前聊天。

## 6. `/use <别名>`

流程：

1. 检查别名和目标 session；
2. 拒绝连接回收站中的 session；
3. 显示目标标题、工作空间和归属信息；
4. 用户点击确认；
5. 原子迁移连接并设置为半衔接；
6. 发送完成状态并撤回确认卡。

`/use` **不回填 transcript**。连接游标从确认时的最新序号开始，之后只处理新事件。

同一个 DSH session 只能连接一个飞书 scope。普通用户需在旧聊天 `/detach`；管理员可在确认卡披露旧 owner
后迁移。

## 7. `/switch`

`/switch` 不接参数，发送两个模式按钮。

### 半衔接 `half`

- 飞书消息进入 DSH Web；
- 针对该飞书消息产生的回复返回飞书；
- Web/TUI 之后独立发起的新回合不抄送飞书。

### 完整衔接 `full`

- 保留半衔接行为；
- Web/TUI 发起的新消息和回复也抄送飞书。

卡片点击后必须显示终态并撤回原选择卡，不能保留“仍待选择”的外观。

## 8. `/detach`

`/detach` 只做两件事：

1. 删除当前飞书连接；
2. 清除当前 scope 的 session 指针。

不会归档、回收或删除 DSH session。下一条飞书普通消息会创建新的独立 session；原 session 仍可在 Web
继续使用，也可再次 `/use`。

## 9. `/rename <别名> [名称]`

有名称时直接重命名；没有名称时打开输入卡。重命名调用 DSH 原生接口，因而：

- `/sessions` 显示新名称；
- DSH Web UI 同步显示新名称；
- 别名保持不变。

## 10. 回收站与永久删除

### `/delete <别名>`

- 先显示别名和真实标题；
- 仅确认后调用 DSH trash；
- session 进入回收站，可从 Web 恢复；
- 别名保留；
- 当前连接和 scope session 指针被清除。

### `/purge <别名>`

- 必须二次确认；
- 调用 DSH permanent purge；
- 删除连接、scope session 指针和别名；
- 不可恢复。

Web UI 只在回收站中提供“彻底删除”，避免正常列表出现高风险按钮。

## 11. 卡片安全

确认卡具备：

- 发起人绑定；
- scope/chat/thread 绑定；
- workspace 与 session 绑定；
- 一次性 nonce；
- 默认 10 分钟有效期；
- owner 变化检测。

成功、取消和失败都会产生清晰终态，随后撤回原卡。旧卡再次点击只返回已过期或已处理，不会重复执行。

## 12. 数据文件

| 文件 | 是否包含 DSH transcript | 用途 |
| --- | --- | --- |
| `<workspace>/.session_aliases.json` | 否 | 别名到 sessionId |
| `profiles/<profile>/sessions.json` | 否 | 飞书 scope 的当前 session |
| `profiles/<profile>/session-projections.json` | 否 | 飞书连接和事件游标 |
| DSH 自己的 session 存储 | 是 | 真实对话，由 DSH 管理 |

因此删除插件映射不会直接删除 DSH transcript；只有 DSH trash/purge 接口改变真实 session 生命周期。
