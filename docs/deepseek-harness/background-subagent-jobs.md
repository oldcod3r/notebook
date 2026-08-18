# 后台 Subagent 的任务模型

前台委派有一个简单但昂贵的约定：父 Agent 调用 Subagent 工具后，一直等待 child 完成，拿到最终答案才继续下一步。

当多个子任务互不依赖时，这种等待会把天然可以重叠的工作串行化。把委派放到后台似乎只需“不要 await”，但一个脱离当前工具调用继续运行的 child 立刻带来更多问题：谁拥有它、怎样找到它、谁能取消它、完成后通知谁，以及父 Agent 退出时是否必须等待它停稳。

DeepSeek Harness 没有为 Subagent 单独发明一套后台协议，而是把一次性委派接入通用 Job/Task 运行时：**Subagent 负责执行，任务运行时负责 id、状态、授权、通知和清理。**

## 后台化改变了取消所有权

前台执行时，当前工具调用的 `AbortSignal` 可以贯穿整个 child 生命周期：父 step 被取消，child 也跟着取消。

后台执行不能继续依赖这条 signal。工具调用在返回 job id 后已经结束；如果之后的父 step 取消仍能终止 child，那么一个已经正式发布的后台任务会被过期调用方意外杀死。

正确的边界是：

```text
工具调用 signal
      │
      ├── job id 发布前 ──→ 可以取消启动
      │
      └── job id 发布后   ──→ 不再拥有 child
                                │
                                ├── job_kill
                                ├── owner dispose
                                └── jobs service dispose
```

后台生产方创建自己的 `AbortController`。任务发布后，取消权转交给任务运行时；启动工具的 signal 与后台 child 正式脱钩。

这和上一节讲的 `SubagentRun` 所有权转移是同一种思想：公开稳定句柄之前，启动方负责回滚；句柄发布之后，由句柄所属生命周期负责结算和释放。

## 为什么使用通用任务运行时

后台 bash、终端进程和 Subagent 的执行细节不同，但它们面对模型时需要相同的控制面：

- 启动后返回稳定 id；
- 查询状态和结果；
- 列出自己可见的后台工作；
- 请求取消；
- 完成时收到通知；
- 所有者释放时自动清理。

如果每种工具都实现自己的 `subagent_wait`、`bash_output`、`subagent_stop` 和 `bash_kill`，模型需要学习多套几乎相同的协议，授权和清理也容易出现不同实现。

通用任务运行时只定义三种模型工具：

| 工具 | 作用 |
|---|---|
| `job_output` | 查看状态，选择等待，并在结算后取得结果 |
| `job_list` | 列出当前调用方有权访问的任务 |
| `job_kill` | 请求取消任务 |

生产方只需要提供执行专属钩子：怎样取消、什么时候完全结束，以及是否支持增量读取。

## 原子启动：先证明任务可控制，再开始工作

后台任务最危险的失败方式，是 child 已经启动，却没有成功返回可收集的 id。它会继续消耗模型额度和修改工作区，父 Agent 却失去了控制入口。

因此 `start()` 必须在调用生产方之前完成所有可能失败的预检：

- 当前是否挂载了任务控制器；
- 调用方是否已经被取消；
- owner 是否超过并发配额；
- id、输出上限和生产方参数是否合法；
- owner 清理钩子能否建立。

预检通过后，生产方启动器只调用一次；返回执行钩子后直接提交任务，不再经过可能失败的注册步骤。

```text
preflight
  ├── failed ──→ producer never starts
  └── passed ──→ producer starts once ──→ publish job id
```

这条顺序保证系统不会创建“没有句柄的后台工作”。

## Subagent 怎样映射为一个 Job

一次性后台 Subagent 注册任务时，会把执行模型适配到通用字段：

| Job 字段 | Subagent 映射 |
|---|---|
| `kind` | `subagent` |
| `label` | 模型为委派提供的简短描述 |
| `owner` | 发起委派的确切父 Agent |
| `cancel()` | 中止任务自有控制器 |
| `done` | 等待 provider 启动、`run.result` 和 `run.dispose()` |
| `readOutput()` | 不提供；只在终态交付最终输出 |

Subagent 不适合复用 bash 的增量输出语义。Child 的中间消息、思考和工具调用仍保留在自己的 Session；父级任务只需要最终答案和终止状态。

如果把 child transcript 持续复制到父任务输出，不仅会增加上下文，还会模糊父子日志的边界。需要观察详细过程时，应读取 child 会话或使用 UI 观察能力，而不是把它伪装成任务 stdout。

## 状态机必须等到资源真正释放

任务状态分为：

```text
running ──→ stopping ──→ killed
   │
   ├──────────────────→ completed
   └──────────────────→ failed
```

`stopping` 不是装饰状态。收到取消只表示已经请求停止，不能立即把任务当作释放完成。只要 child 或进程树仍在退出，它就继续占用 owner 的并发名额。

对后台 Subagent 来说，`done` 要同时等待：

1. provider 启动完成或完整回滚；
2. child 的结果结算；
3. `SubagentRun.dispose()` 完成；
4. 相关 Agent、监听器或外部进程完全停稳。

停止原因再映射到任务终态：

| Subagent 结果 | Job 状态 |
|---|---|
| `completed` | `completed`，携带最终输出 |
| 主动中止 | `killed` |
| 拒绝、token 上限、模型或协议失败 | `failed` |
| 启动、结果或释放基础设施失败 | `failed`，保留诊断 |

被截断的部分回答可以作为诊断保留，但不能被包装成成功结果。

## `done` 为什么不能随意 reject

任务运行时需要一个最终承诺：生产方的 `done` 最终会结算，并且结算时资源已经释放。如果生产方直接抛出异常而没有形成终态，owner dispose 可能永远不知道应继续等待还是任务已经失联。

因此生产方把错误转换为 `failed` 结果。运行时记录第一个终态，完成等待方和通知，再隔离每个监听器的错误；后来的结果不能覆盖第一次诊断，也不能重复发送通知。

如果 `cancel()` 自己抛错，运行时会把任务标记为失败并警告可能存在资源泄漏。但它仍不能假装工作已经停稳——若 `done` 始终不完成，资源销毁仍会被阻塞。

这是一条刻意严格的约定：宁可暴露一个不遵守停止协议的生产方，也不能在后台遗留工作仍运行时宣布系统已经安全退出。

## 所有权既用于授权，也用于清理

Job id 在运行时全局可见，而且通常是可预测的，例如 `subagent-3`。安全性不能依赖别人猜不到 id，必须在每次读取、等待、列出和取消时检查调用方。

运行时同时保存两种 owner 身份：

| 身份 | 用途 |
|---|---|
| 持久的 `SessionId` | 判断哪个会话可以访问任务 |
| 确切的在线 `Agent` 对象 | 决定清理和完成通知交给哪个运行实例 |

只比较 session id 不足以处理生命周期。旧 Agent 退出后，新 Agent 可能复用相同会话；它可以读取属于该会话的任务结果，但旧实例的清理回调和通知不应被重定向给替代对象。

父 Agent 的第一个后台任务会在其作用域中注册异步清理。父级释放时，运行时取消其所有未终止任务，并等待每个生产方真正结束。于是 `AgentHandle.dispose()` 的“完成”包含所属后台工作已经完全停稳这一承诺。

需要比 owner 活得更久的工作，不能偷偷绕过这条规则。它必须采用无 owner 生命周期；若还要跨进程重启存续，则需要单独设计持久任务协议。

## 完成通知不是生命周期保证

任务完成后，系统会尝试把通知送给启动时捕获的确切 owner：

- owner 正忙时，把消息注入当前执行流程；
- owner 已空闲时，唤醒一个后续轮次；
- owner 正在释放且投递目标已不存在时，丢弃通知。

通知可能丢失，但清理不能丢失。后台生命周期的硬承诺是 child 最终被结算或取消，并随 owner 完全释放；通知只是帮助模型及时发现结果的交互能力。

如果模型已经通过 `job_output(wait: true)` 收到了终态，或主动 `job_kill` 结束任务，任务会被标记为已报告，不再注入重复的完成通知。

## 模型不应该忙等轮询

后台化的目的，是让父 Agent 在等待期间继续处理独立工作。如果模型启动任务后立刻连续调用 `job_output`，只会把异步协议重新退化成昂贵的轮询循环。

系统提示词引导模型采用下面的节奏：

1. 保存返回的 job id；
2. 启动其他互不依赖的任务；
3. 在后台任务运行时继续本地分析；
4. 只有下一步依赖结果时才等待；
5. 最终回答前收集相关任务；
6. 终止已经不再需要的工作。

运行时不能保证模型一定遵守这套习惯，但可以强制授权、容量和 owner 清理边界。

## 两层并发限制解决不同问题

同一条 assistant 消息里的多个 Subagent 调用可以并发分发，受 `maxParallelToolCalls` 限制。但后台调用一旦返回 job id，就释放了工具池位置，child 仍在继续运行。

因此还需要任务运行时自己的 owner 容量限制。当前进程内实现默认允许每个确切 owner 最多同时拥有 10 个活动任务；`running` 和 `stopping` 都计入额度，直到 `done` 真正结算才释放。

```text
工具并发池：限制“同时有多少调用尚未返回”
Job owner 配额：限制“后台还活着多少工作”
```

只设置前者，模型可以分多轮不断启动任务，实际后台数量无限增长。只设置后者，则一次批量委派可能在启动阶段造成不必要的串行等待。

## One-shot Job 与 continuable child 不是一回事

当前后台 Subagent 有两种不同生命周期：

| | One-shot Job | Continuable child |
|---|---|---|
| 返回句柄 | job id | 持久 subagent id |
| 执行单位 | 一次运行、一个终态结果 | 一个 Session、多轮对话 |
| 结果获取 | `job_output` | child transcript 与结算通知 |
| 后续消息 | 不支持 | `send_message` / follow-up |
| 取消 | `job_kill` 终止整个任务 | interrupt 当前轮次，保留 inbox 与 child |
| owner 退出 | 取消并释放任务 | 按 child-first 所有权图排空 |
| 重启恢复 | 不支持 | 已写入持久日志的 child 可以冷恢复 |

One-shot 后台模式默认仍以前台运行；模型显式选择 `run_in_background: true` 才返回 job id。可继续模式则后台优先，因为它本来就拥有独立 Session、持久 id 和结算通知；只有下一步必须依赖结果时，才显式选择前台等待。

把两者都叫“后台 Subagent”没有问题，但控制协议不能混用。Job 表示一次可收集结果的执行；持久 child 表示可以再次对话的身份。下一篇将专门展开后者。

## 接入一个后台生产方的最小清单

新的长时间运行工具要接入通用任务运行时，至少应回答这些问题：

### 启动

- 所有可能失败的预检是否发生在实际工作之前？
- id 发布后，启动工具的 signal 是否与任务脱钩？
- 并发准入是否在创建工作和分配 id 之前完成？

### 取消与结束

- `cancel()` 是否幂等，并一定推动 `done` 结算？
- `done` 是否只在资源完全释放后完成？
- 取消请求期间是否仍占用容量？
- 执行失败和释放失败能否分别诊断？

### 输出

- 输出是消费式增量，还是幂等最终结果？
- 输出上限由哪个组件负责？
- 部分输出会不会被误报为成功？

### 所有权

- 谁可以读、等和取消？
- owner 释放是否取消并等待所有任务？
- 完成通知如何处理忙碌、空闲和正在退出的 owner？

最后做一个破坏性测试：启动工作后立刻释放父 Agent。如果父级 dispose 已返回，而 child 仍在运行，后台生命周期就还没有真正闭合。

## 延伸阅读

- [后台 Subagent 任务](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-07-08-background-subagent-tasks.zh.md)
- [后台任务运行时与通用控制工具](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)
- [并行 Subagent 委派](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.zh.md)
- [可继续委派采用后台优先](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-11-background-first-continuable-delegation.zh.md)
- [Subagent 工具说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent/README.zh.md)
