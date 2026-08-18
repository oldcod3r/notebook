# 长对话的上下文压缩机制

长时间运行的 Agent 会不断积累用户消息、模型回答和工具结果。事件日志可以无限增长，模型上下文窗口却是有限的。接近上限时，系统不仅可能报错，还会因为注意力被旧信息稀释而提前退化。

上下文压缩的目标不是删除历史，而是用一条可回放的摘要替换模型当前可见的较早区间，同时保留近期完整步骤。DeepSeek Harness 把它拆成四个独立问题：**容量由谁判断、范围如何选择、摘要怎样写入、溢出后何时允许重试。**

## 压缩作用于投影，不改写事件日志

前文的 Session surface 已经提供了 `replace(start, end)`。压缩引擎追加一条带规范来源的 `user/message`，让它遮蔽一段旧 surface：

```text
原 surface：  [旧消息 A] [旧步骤 B] [近期步骤 C] [当前输入 D]
压缩后：      [摘要 S]              [近期步骤 C] [当前输入 D]
原始日志：    A、B、C、D、S 全部保留
```

摘要使用 user 角色并不是协议技巧：它本质上就是提供给模型的一段上下文。`compaction/start`、`compaction/summary` 和 `compaction/end` 只记录过程，不进入模型历史。

`sourceEventSeqs` 必须覆盖被遮蔽的 surface 节点，使回放能够验证摘要确实替换了它声称处理的全部来源。

## 接口只定义动作，算法留给后端

压缩能力公开三个操作：

| 操作 | 语义 |
|---|---|
| `compactIfNeeded()` | 根据压力或上下文溢出判断是否压缩 |
| `compactNow()` | 用户显式请求一次有效缩减 |
| `compactRegion()` | 压缩指定的合法 surface 区间 |

接口不实现 token 求和、尾部保留或摘要生成。不同模型、不同业务和不同工具结果结构可能需要完全不同的策略；把算法写进抽象类，只会迫使新后端与默认策略对抗。

Token 测量也不属于压缩引擎。独立 meter 负责按真实 provider/model 请求重建并估算，压缩只消费结果。这样计价、回放与模型路由仍有唯一责任方。

## 压力检查必须发生在稳定边界

成功步骤后的压缩检查安排在下一个 `agent/pre-step`：上一响应、工具结果和上下文注入已经持久化，下一个模型请求尚未派生。

```text
assistant/message → tool/result → step/end
领取下一批输入 → pre-step 压力检查 → step/start → 新请求
```

如果在请求包装器里临时改写消息，压缩结果无法回放；如果在工具结果尚未提交时检查，测量又会漏掉刚刚产生的大块内容。

工具密集型 ReAct 轮次可能在一个 turn 内执行很多 step，因此检查按成功 step 进行，而不是每轮一次。否则单轮就可能越过窗口上限。

## 范围选择必须保持工具配对完整

压缩从 surface 尾部向前保留近期内容，把更早的头部变成摘要。但切割点不能把 assistant 的工具调用与对应结果分开。

```text
错误： [assistant 调用 tool] | 压缩边界 | [tool result]
正确： | [assistant 调用 tool] [tool result] | 作为完整单元保留或压缩
```

因此范围选择以已闭合步骤或独立消息为单元。若尾部仍有未完成工具调用，压缩宁可返回 `null`，等步骤闭合后重试，也不生成提供方无法接受的 transcript。

一个无法拆分的超大 user 消息仍可能超过窗口；上下文压缩不是任意大输入的通用修复。可预测的巨大文本工具结果可以先由无模型 pruner 裁剪，再决定是否需要摘要调用。

## 模型容量属于路由适配器

同一个 model id 可能由不同 provider 路由到不同容量。压缩插件不能维护第二份模型目录，也不能对所有请求使用一个全局窗口。

正确的责任划分是：

- LLM adapter 返回精确路由的 `contextWindow`；
- token meter 保持模型无关，只计算请求大小；
- 压缩策略根据 provider/model 容量计算阈值和保留预算。

默认策略可以在窗口约 80% 时触发，并保留约 16% 的近期历史，但这些只是策略值，不是通用常量。缺少容量信息时，主动压力检查无法可靠工作；真实 provider 报出的上下文溢出仍可作为兜底信号。

## 溢出恢复必须由持久进展授权

Provider 报告 `CONTEXT_WINDOW_EXCEEDED` 后，系统关闭失败 step，在错误 waterfall 中尝试强制压缩，再开启新的编号 step 重建请求。

不能只因为压缩函数“返回成功”就重试。自定义后端可能返回一个结果，却没有改变模型可见 surface。DeepSeek Harness 使用 `replaceGeneration` 的增长作为权威证据：只有 pruner 或摘要真正提交了替换，才返回 retry。

```text
provider overflow
  → close failed step
  → prune / compact
  → surface generation changed?
       ├── no  → preserve original error
       └── yes → open new step and rebuild request
```

重试有明确上限，取消优先。无关错误、没有安全范围或替换前失败，都保留原始 provider 错误，避免用“压缩失败”遮蔽根因。

## 日志事件同时充当持久锁

摘要生成可能是一次缓慢模型调用。`compaction/start` 与 `compaction/end` 既记录过程，也阻止同一 Session 上并发压缩。

未匹配的 start 在当前生命周期中表示活动锁；新生命周期的 end-seed 可以证明旧 start 已经陈旧。这样崩溃不会留下一个无法解释的内存 mutex，也不需要核心 Session 修复认识插件事件。

成功顺序固定为：

```text
compaction/start
  → 生成摘要
  → compaction/summary
  → user/message + surface replace
  → compaction/end
```

Surface 变更发生在锁内，end 最后落盘。摘要失败时尽力写入带 error 的 end，保持 surface 不变并留下可诊断记录。

## 收敛不是“摘要一次就结束”

摘要本身也占 token，隐藏推理 token 和 provider 输出预算还会影响实际容量。压缩只能要求单调进展：每次提交的摘要必须小于被遮蔽内容；如果压力仍高，可以按有限次数继续合并头部检查点。

自动压缩始终从头部开始，把旧检查点和新增历史合并，避免每次压缩都留下一个新的摘要节点。手动中间范围压缩则可以保留多个检查点。

## 落地检查清单

- 只有一个组件拥有模型容量事实。
- 压缩针对已持久化请求，而非临时消息数组。
- 切割点保持工具调用/结果和步骤结构平衡。
- 摘要作为声明式替换写入日志，原事件不删除。
- 只有模型可见投影发生变化才允许溢出重试。
- 并发压缩有持久、可恢复的排他证据。
- 摘要必须产生单调缩减，且重试次数有上限。
- 对不可分割的大节点明确承认无能为力。

## 延伸阅读

- [压缩作为能力 seam](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-06-18-compaction-capability-seam.zh.md)
- [路由模型上下文与压缩策略](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-07-20-routed-model-context-and-compaction-policy.zh.md)
- [调用后压缩与溢出恢复](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-07-10-after-call-compaction-pressure-and-overflow-recovery.zh.md)
