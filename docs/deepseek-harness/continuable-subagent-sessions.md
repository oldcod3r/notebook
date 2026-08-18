# 可继续对话的持久化 Subagent

一次性 Subagent 很容易定义：启动一轮工作，等待一个结果，然后释放运行句柄。

但有些 child 不是一次性函数。父 Agent 可能先让它调研，再根据结果追加问题；进程为了节省资源可以暂时释放它，稍后又要从持久化历史恢复；child 还可能拥有自己的后代，不能在一个轮次结束时直接销毁。

这时，“一次委派”与“一个子 Agent”不再是同一个生命周期。DeepSeek Harness 用三层概念把它们拆开：**持久 Session 表示 child 身份，Activation 表示一次在线驻留，inbox 中的消息表示一轮轮工作。**

## 先分清三个生命周期

```text
持久 child Session
└── Activation A：进程内驻留
    ├── round 1：初始任务
    ├── round 2：follow-up
    └── round 3：follow-up

    <释放内存，Session 仍在>

└── Activation B：冷恢复后的新驻留
    └── round 4：新的 follow-up
```

三个概念各自回答不同问题：

| 概念 | 回答的问题 | 生命周期 |
|---|---|---|
| Session | “这是哪个 child，它经历过什么？” | 持久，可跨驻留与进程重启 |
| Activation | “这个 child 当前是否加载在内存里？” | 短期，拥有一个 `AgentHandle` |
| Round | “这条消息触发的工作何时完成？” | 一次 inbox 消费与模型执行 |

同一个 child 始终使用同一份 Session，但同一时刻至多只有一个 Activation。Activation 可以处理许多轮次，也可以在完全停稳后释放，再由下一条消息冷恢复。

## 为什么不能继续用后台 Task

上一章的一次性 Job/Task 有一个明确终点：一个生产者、一次结算、一个最终结果。可继续 child 没有这样的唯一终点。

如果用 Task 包装它，会立刻遇到几个无法一致回答的问题：

- 第一轮结束算 Task 完成，还是等未来所有 follow-up？
- Task 完成后 child 还能不能继续接受消息？
- 恢复后的新 Activation 属于旧 Task 还是新 Task？
- `job_kill` 应取消当前轮次、整个 child，还是它的全部后代？
- Task 结果与 child transcript 哪个才是权威输出？

这些问题不是缺少几个状态，而是抽象错位。可继续 child 的执行顺序已经由 Agent inbox 管理，再增加 Task 队列会制造第二个 FIFO 和第二套取消边界。

因此当前设计明确分流：

- `SubagentRun` 与 Task 只表示 one-shot；
- 可继续 child 直接由 Session、Agent inbox 和 continuation manager 管理；
- `startContinuable()` 返回 child id，不返回一个等待终局的结果 promise。

## 启动成功的边界是 inbox 接受

创建可继续 child 时，系统要完成身份预留、provider 准备、Session 创建、组合安装、父子所有权建立和初始消息投递。

`startContinuable()` 在 child inbox 接受初始提示词后返回：

```ts
type ContinuableStartResult = {
  childId: string;
  messageId: string;
};
```

这个返回值只承诺两件事：

1. child 身份已经发布；
2. 初始消息已经被 inbox 接受。

它不等待轮次开始，也不等待消息写入 Session，更不等待 child 给出结果。

在 inbox 接受之前发生任何失败，创建过程必须完整回滚，不返回 child id。接受之后，调用方 signal 就不再拥有这条消息；child 的 Activation 和轮次由 continuation manager 独立管理。

这条边界避免两种坏状态：对外公布一个从未收到首条任务的 child，或者 child 已经接受工作，父调用却仍能用过期 signal 把它撤回。

## 单一 inbox 是唯一的轮次队列

父级向 child 发送后续消息时，系统复用 `Agent.followup()`。每条被接受的消息都进入同一个 FIFO：

```text
initial prompt
follow-up A
follow-up B
runtime settlement/context
```

Continuation manager 不维护自己的“待执行 Activation 队列”，也不为每次 follow-up 创建 Task。消息顺序、认领和丢弃仍由 Agent inbox 的既有事件协议负责。

这让路由只依赖 Activation 当前是否驻留：

| 状态 | follow-up 的处理 |
|---|---|
| `running` | 排入当前 Activation 的 inbox |
| `waiting` | 唤醒同一个 Activation |
| 没有 Activation | 从持久 Session 冷恢复，再投递消息 |

成功投递只返回稳定 `MessageId`。它不返回 `started`、`queued` 或 `resumed` 等 Subagent 专属状态，因为这些标签没有提供额外的结果能力，还会重复运行时瞬时状态。

## Follow-up 不是 steering

Child 正在执行时收到新消息，这条消息不会修改当前轮次，而是在当前轮次之后开启一个新轮次。

这是一条重要的产品语义：

- **follow-up** 保证 FIFO，可持久地表达“接下来再做”；
- **steering** 表达“立刻修正现在正在做的事”，需要当前轮次控制权与不同的准入协议。

把两者自动合并会产生不可预测行为：同一条消息有时插入当前推理，有时排到下一轮，有时在冷恢复后执行。当前模型选择一致排队；未来若提供 steering，应当是独立、只在线可用且失败时绝不退化为 follow-up 的操作。

## Activation 状态从事实推导，而不是再建状态机

管理器根据 Agent 是否停稳、inbox 是否有唤醒工作，以及它是否仍拥有 child，推导三种内部驻留状态：

| 状态 | 条件 | 行为 |
|---|---|---|
| `running` | 有准入、活跃轮次或会唤醒的 inbox 工作 | 保持驻留并继续执行 |
| `waiting` | 自身已停稳，但仍拥有未释放 child | 保留 `AgentHandle` 等待后代 |
| `settled` | 自身停稳，且所有 child 已释放 | dispose handle，移除 Activation |

管理器不维护第二份可变枚举作为真源。状态从 Agent 和所有权集合推导，避免“标记为 idle，但 inbox 已有消息”或“标记为 finished，但 child 仍在运行”的分歧。

`waiting` 尤其关键。一个父 child 自己已经不再调用模型，但它的后代仍然在线；如果此时释放父 handle，就会丢失返回通道和 child-first 清理所需的所有权关系。

## 持久谱系与在线所有权不是一回事

Child Session header 中记录 `parentSession`，用于回答“它由哪个会话创建”。但一个持久 id 不能证明对应 parent 当前仍在线并实际拥有 child。

在线 Activation 另外维护 `ownedChildren: Set<SessionId>`：

- 持久 `parentSession` 用于谱系、发现和冷恢复授权；
- 在线 `ownedChildren` 用于驻留、取消和 dispose 顺序。

当一个可继续 parent 创建 child 时，child 在开始运行或接收消息之前就加入 parent 的所有权集合。只有 child 完全停稳、它自己的后代全部释放、最终 flush 尝试完成且 handle dispose 后，才从 parent 集合移除。

身份集合比引用计数更合适：系统能明确知道哪个 child 尚未完成清理，重复释放也不会把计数减到错误状态。

## 为什么必须 child-first 释放

考虑一棵嵌套委派树：

```text
root
└── researcher
    ├── source-a
    └── source-b
```

如果先释放 `researcher`，两个孙级即使稍后完成，也找不到仍然在线的直接 parent；结果通知和 report 可能丢失，所有权图也失去中间节点。

正确的释放顺序是：

```text
传播取消：root → researcher → leaves
释放 handle：leaves → researcher → root
```

取消自顶向下传播，让每层尽快停止新工作；资源释放按 child-first 完成，确保后代还有机会在 parent 在线时收尾。

管理器卸载会排空全部在线森林；宿主关闭某个顶层 Agent 时，只排空这个确切根节点下的后代，不影响其他会话树。两者都先关闭对应范围的新准入，再等待已经获准的创建过程完成发布或回滚。

## 冷恢复不再经过初始 Provider

Provider 只决定一个全新 child 怎样创建：空白 spawn，还是携带某段种子历史。创建后，Session 已经保存初始前缀、provider 名称、模式、模型、persona 和工具限制等重建描述符。

冷恢复时，continuation manager 直接：

1. 读取并校验持久描述符；
2. 恢复 Session；
3. 重建 Agent 组合；
4. 安装新的 Activation；
5. 将 follow-up 交给 inbox。

它不会再次调用初始 provider 的 `resume()`。否则一个已经存在的 child 会依赖最初 provider 仍然加载，还可能让 provider 重做前缀或创造第二份恢复状态。

这个设计也解释了为什么描述符只保存明确的重建字段，而不是序列化整个可扩展 `AgentOptions`：恢复协议应该稳定、封闭，不被无关插件字段意外改变。

## 中断只停止当前轮次

可继续 child 需要一种比“销毁整个 child”更细的停止操作。`interrupt` 的语义是：

- 只向在线目标当前轮次发送取消；
- 保留 Activation；
- 保留尚未领取的 inbox 消息；
- 不级联取消已发布后代；
- 接受请求后立即返回，不等待完全停稳。

```text
running round ── interrupt ──→ canceled round
queued follow-ups             → retained, paused
child identity                → retained
descendants                   → keep running
```

被当前轮次已经领取的工作不会重新入队。待处理消息也不会因为中断而自动启动下一轮；之后一次显式 follow-up 会按原 FIFO 顺序重新唤醒 child。

这和 one-shot 的 `job_kill` 有本质区别：后者终止整个任务并等待资源释放，前者只是控制持久 child 的一个运行片段。

## 父到子、子到父是两条不同通道

### 父到子：`send_message`

父级使用 child id 投递后续消息。服务根据确切在线直接 parent 做最终授权；消息中记录的 sender 字段只用于审计，不能凭它获得权限。

一次列表结果也不授予发送权。列表只是快照；真正投递时仍要重新检查 child 描述符、parent 身份、drain 状态和 Activation 所有权。

### 子到父：`report`

可选的 child 作用域 `report` 工具让 child 主动发送阶段性发现或最终交接。它没有接收方参数，服务从持久 `parentSession` 推导唯一直接 parent，避免 child 自行选择任意目标。

Report 可以选择：

- `wakeup`：开启一个父级后续轮次；
- `quiet`：只注入上下文，等待父级下一次自然请求。

调用 report 不会结束 child 当前轮次，也不会使 Activation 结算。它是协作式通信，不是生命周期信号。

## 运行时结算通知为什么仍然必须存在

只依赖 child 主动 report 不够。恰恰在父级最需要知道结果的几种情形——token 上限、模型失败、取消或拆卸——child 没有机会遵守“结束前报告”的指令。

因此 continuation manager 会为每个已经向调用方公布 id 的 Activation 无条件发送结算通知，包含：

- 本次驻留怎样结束；
- child 最后产生的 assistant 内容，或明确说明没有内容；
- 独立的 `subagent-settled` 来源标记。

Report 与 settlement 的作者不同：

| 消息 | 作者 | 语义 |
|---|---|---|
| `subagent-report` | child 模型 | “这是我选择告诉你的内容” |
| `subagent-settled` | 运行时 | “这个 Activation 实际这样结束” |

即使 child 已经 report，结算通知也不抑制。它可能造成内容重复，但保留了无条件终止保证，也覆盖“先报告进度，随后失败”的情况。

通知必须在释放父级对 child 的所有权之前投递。若先释放，父级可能立即被判断为 settled 并 dispose，清空刚刚进入 inbox 的通知。繁忙父级会在最近 step 边界批量认领同时到达的多条结算，避免每个 child 都单独开启一轮。

## 委派策略在创建时固定

可继续 child 会在创建调用第一次 `await` 之前，捕获父级显式沙箱覆盖，并把 child 审批策略钉定为 `never`。这些值写入 child 自己的 Session 日志。

冷恢复只回放已经持久化的委派事件，不重新读取父级当前策略。否则同一个持久 child 会因为恢复时机不同而获得不同权限。

因此策略语义是：

> Child 继承创建时已经授予的执行范围，但不能替父级申请更高权限；父级之后的策略变化不追溯影响它。

想让 child 使用新策略，应当创建新的委派，而不是让一次恢复悄悄改变权限。

## 持久化真正保证了什么

Session 和 descriptor 可以跨进程重启保存，但 Activation、inbox 和在线所有权图仍是内存状态。

这产生一条重要边界：**inbox 接受不等于消息已经持久化。**

如果进程在消息被接受、但该消息尚未进入 child Session 日志时崩溃：

- child 身份和旧历史可能仍然存在；
- 后续消息可以再次冷恢复它；
- 刚才那条只存在于 inbox 的消息可能丢失；
- 系统不会假装自动重放一次不确定是否执行过的工作。

同样，结算通知只是投递，不是持久 mailbox。Parent 离线或正在 dispose 时，通知可能没有被模型读取；child Session 仍是持久结果的最终来源。

要提供“接受后必达”和跨进程所有权，还需要额外设计持久 inbox、离线 mailbox、幂等键、回执和共享 lease。当前模型没有隐含这些保证。

## 在自己的系统里落地

实现持久 Subagent 前，可以先固定下面六条不变量。

### 身份

- 一个 child 对应一个持久 Session id。
- 一个 Session 同时至多有一个在线 Activation。
- 恢复输入来自封闭、版本化的描述符。

### 消息

- 所有轮次只经过一个 inbox FIFO。
- Follow-up 永远表示下一轮，不自动 steering 当前轮次。
- 接受、写入日志和完成是三个不同确认点。

### 所有权

- 持久 parent id 负责谱系，在线集合负责资源所有权。
- Parent 在所有 child 完全释放前不能结算。
- 取消向下传播，handle 按 child-first 释放。

### 通信

- Parent→child 和 child→parent 分开授权。
- 模型主动报告与运行时结算通知使用不同来源。
- 结算通知不能依赖模型是否遵守 report 指令。

### 权限

- 委派时捕获策略，恢复时回放，不重新继承。
- Child 不获得替 parent 请求权限的能力。

### 持久性

- 明确 inbox 接受是否具有重启保证。
- 没有持久 mailbox 时，不承诺离线通知必达。
- 多进程共享存储前，先设计 lease 与唯一在线 Activation 协议。

最后可以用一个场景验证整个模型：创建 parent→child→grandchild，child 完成自身工作但 grandchild 仍运行；此时 child 必须停留在 waiting。关闭 parent 时，取消应向下传播，而 dispose 必须从 grandchild 开始逐级向上完成。如果任一顺序相反，所有权边界仍有漏洞。

## 延伸阅读

- [可继续的 Subagent 对话](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-07-28-continuable-subagent-conversations.zh.md)
- [当前轮次中断](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.zh.md)
- [管理器负责结算通知](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)
- [可继续 Subagent 策略继承](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-10-continuable-subagent-policy-inheritance.zh.md)
- [Subagent 控制工具](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-control/README.zh.md)
- [Subagent Report 工具](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/tool-subagent-report/README.zh.md)
