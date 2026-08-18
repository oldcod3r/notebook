# 工具取消与副作用边界

取消不是让 Promise 提前返回一个 `ABORTED`。如果工具已经开始写文件、启动进程或调用外部 API，调用方停止等待并不会让这些工作消失。

DeepSeek Harness 采用协作式取消：每个工具调用都携带调用方拥有的 `AbortSignal`，工具和调度包装层负责观察并传播；注册表只有在已启动工作真正停稳后，才报告调用结束。

## Signal 必须由调用方拥有

工具注册表不知道一次调用属于用户轮次、后台任务、超时包装还是宿主关闭，因此无法提供语义正确的默认 signal。

`signal` 应是必填参数：

```ts
execute(args, { signal })
```

调用方显式传入自己拥有的生命周期。注册表不创建永不中止哨兵，也不在缺失时偷偷补一个 controller。

这让每个工具都能无类型断言地观察取消，也迫使新增调用路径回答“谁拥有这次工作”。

## 不同流水线阶段拥有不同权限

工具实现、前置策略、后置策略和观察者只应借用只读 signal。环绕调度层则可能需要临时替换它，组合截止时间或词法取消作用域。

如果所有阶段都能修改 signal，任意策略可以重写调用方生命周期；如果所有阶段都只读，超时包装又无法安全组合。类型应按阶段区分可变性，而不是暴露一个全局可变执行对象。

## 取消发生在哪个阶段很重要

一次调用可能在以下位置被取消：

| 阶段 | 是否可能产生工具副作用 |
|---|---|
| 参数解析或前置策略前 | 否 |
| 审批等待中 | 否 |
| 调度/限流等待中 | 否 |
| 工具体已经启动 | 是 |
| 后置策略等待中 | 已经可能产生 |

一个统一 `ABORTED` 无法告诉恢复逻辑“工具从未运行”还是“工具可能已经写了一半”。终态需要保留是否真正进入过工具体的事实。

这对持久日志尤其重要：只有知道调用是否可能产生副作用，恢复时才能决定是否安全重试。

## 为什么不能让 Promise 与 signal 竞速

常见写法是：

```text
Promise.race([toolWork, aborted])
```

Signal 获胜后调用方立即得到取消结果，但 `toolWork` 仍在后台运行。它可能稍后修改文件、占用进程或抛出无人处理的错误。

正确实现是工具观察 signal，主动停止底层工作，并让执行 Promise 只在清理完成后结算。对无法协作停止的 API，应把不可取消性作为显式限制，而不是用竞速伪装。

## 取消请求与完全停稳是两个时间点

```text
request cancel
  → signal aborted
  → tool observes
  → stop subprocess / request / worker
  → drain callbacks and resources
  → execution settles
```

调用方可以快速确认“取消已请求”，但资源生命周期不能在最后一步之前结束。后台任务的 `stopping` 状态和 Subagent 的 `dispose()` 都建立在同一原则上。

## 进入时已经取消要短路

工具在真正执行前应检查 signal。一个预先取消的调用不应该启动进程后再立刻杀掉，也不应发出外部请求。

但短路必须发生在必要的持久化物化之后：如果会话协议要求每个模型发出的工具调用都有对应结果，系统仍需记录调用与 aborted 结果，使 transcript 保持结构平衡。

## 截止时间只是另一种取消来源

超时包装不应另造一套工具错误协议。它组合调用方 signal 和 deadline，向工具传递一个派生 signal；超时触发后仍等待工具完全停止，再把终止原因归类为 timeout。

调用方取消和超时同时发生时，要有稳定优先级，不能由微任务竞态决定用户看到哪个错误。

## 外部协议需要双重停止

对 ACP、Codex 或 Claude Code 等产品进程，取消通常包含两层：

1. 尽力发送原生协议的 cancel/close；
2. 由共享子进程服务终止并等待整棵进程树退出。

协议关闭表达友好意图，但不能证明子进程已经退出。只 kill 直接进程也可能留下孙进程。完全停稳必须以受管进程树的退出事实为准。

## 取消后的结果如何记录

- 未进入工具体：记录 aborted，明确无工具副作用。
- 已进入并成功协作停止：记录 aborted，并标记曾经调度。
- 工具先失败、随后收到取消：保留原始失败，不把失败改写成取消。
- 取消过程自身失败：记录清理失败，并警告可能仍有工作存活。
- 部分输出：可以作为诊断保留，不能改报为成功。

原则是永不高估成功，也不丢失已经发生的失败事实。

## 接入检查清单

- 每条直接调用路径都提供明确 owner signal。
- 进入 I/O 前检查预取消。
- 底层库、子进程和回调都能观察取消。
- 执行 Promise 在资源停稳后才结算。
- 取消与超时有稳定优先级。
- 结果区分是否进入过工具体。
- 并发调用各自拥有独立 controller。
- Dispose 幂等，并聚合结果失败与清理失败。
- 测试覆盖取消发生在审批、排队、执行和后置阶段。

## 延伸阅读

- [注册表边界上的协作式工具取消](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-07-19-cooperative-tool-cancellation.zh.md)
- [显式轮次取消](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.zh.md)
- [工具调用超时策略](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-07-07-tool-call-timeout-policy.zh.md)
