# Subagent 能力抽象与多后端共存

“让一个 Agent 把任务交给另一个 Agent”听起来只是一次函数调用：传入任务，等待答案。

真正实现时，子 Agent 可能与父 Agent 运行在同一个进程，也可能是 ACP 子进程、Codex app-server、Claude Code SDK，甚至未来的远程 A2A 服务。它们对上下文继承、结构化输出、取消、权限和资源回收的支持都不相同。

如果父 Agent 直接理解每种后端，委派逻辑很快就会变成传输协议的集合。DeepSeek Harness 在它们之间放了一条 Subagent seam：**调用方只面对统一的委派生命周期，具名 provider 负责把这套生命周期映射到具体执行世界。**

## 为什么不能只有一个 Subagent 实现

Shell 执行器通常只需要一个当前实现：在这台机器上，命令要么通过本地 shell 跑，要么通过某个统一的远端执行器跑。注册第二个实现往往意味着配置冲突。

Subagent 不一样。同一个父 Agent 可能同时需要：

- 一个廉价的进程内 child，快速完成边界明确的分析；
- 一个继承父会话历史的 fork child，复用已有上下文；
- 一个隔离的 ACP child，在独立进程中执行；
- 一个真实 Codex 或 Claude Code 产品进程，利用其原生工具和设置。

它们不是互相替代的部署选项，而是可以同时暴露的能力。因此 Subagent 服务不是单实例执行器，而是一个**具名 provider 注册表**。

```text
ctx.subagents
├── spawn          → 进程内全新 child
├── fork           → 进程内、继承父级已完成历史
├── acp            → ACP 子进程
├── codex          → Codex app-server
└── claude-code    → Claude Code Agent SDK
```

调用方按名称选择 provider；注册表负责重名拒绝、能力校验和共同生命周期，provider 只负责自己的执行方式。

## 三层边界：接口、实现、消费方

这条 seam 分成三种角色：

| 层 | 责任 | 不负责什么 |
|---|---|---|
| Service Definition | provider 注册表、请求、结果、能力和生命周期事件 | 不创建具体 child |
| Service Provider | 把统一请求映射到进程内 Agent 或外部产品 | 不决定模型何时使用它 |
| Consumer | 把某个 provider 包装成面向模型的工具 | 不实现传输协议 |

这个拆分避免了两种常见耦合：

1. 为接入一个新产品修改 Agent loop；
2. 让产品 adapter 自己发明任务 schema、错误语义和取消约定。

只要新后端能实现相同的启动、结算与释放边界，父 Agent 就不需要知道它背后是对象、子进程还是网络连接。

## 核心原语：`start → SubagentRun`

一次性委派的最小抽象不是 `run(prompt) → text`，而是：

```ts
interface SubagentProvider {
  name: string;
  capabilities: SubagentCapabilities;
  start(request: SubagentStartRequest): Promise<SubagentRun>;
}

interface SubagentRun {
  id: string;
  result: Promise<SubagentResult>;
  dispose(): Promise<void>;
}
```

之所以需要一个独立的 run，是因为“子 Agent 已经发布”和“子 Agent 已经完成”是两个不同时间点。

### 发布之前：provider 拥有一切

`start()` 兑现之前，provider 仍拥有启动过程中的所有资源。如果可执行文件不存在、能力不支持、工作目录无效或初始化握手失败，它必须完全回滚，然后拒绝 `start()`。

这时调用方拿不到 child id，也不会看到一对不完整的生命周期事件。系统表现为“这个 child 从未成功建立”。

### 发布之后：所有权转交调用方

`start()` 返回 `SubagentRun` 后，child 身份已经稳定，run 的所有权转给调用方。后续模型失败、拒绝、token 上限或取消通过 `run.result` 结算，不应再伪装成启动失败。

调用方无论得到什么结果，都必须调用 `dispose()`。释放操作不仅发送取消，还要等待 child、协议连接和受管进程树完全停稳。

```text
provider owns setup
        │
        ├── setup failed ──→ rollback ──→ start rejects
        │
        └── publish run ───→ caller owns run
                                  ├── await result
                                  └── dispose and await full stop
```

这条所有权分界让进程内 Agent 和外部产品能够共享相同的错误模型，而不掩盖已经存在的 child。

## 能力必须在启动前响亮拒绝

不同 provider 能执行的请求不同。进程内 child 可以限制工具、设置 persona 或强制委派深度；进程外产品通常拥有自己的工具注册表和递归策略，父进程无法证明这些限制真的生效。

DeepSeek Harness 把启动能力放在静态描述符中：

| 能力 | 含义 |
|---|---|
| `outputSchema` | 强制结构化最终结果 |
| `depthLimit` | 强制最大委派深度 |
| `toolFilter` | 限制 child 可见工具 |
| `persona` | 为 child 应用独立角色指令 |

服务在调用 provider 之前检查请求。后端不支持某项能力时，调用必须失败，不能“接受参数但悄悄忽略”。

静默降级对 Agent 尤其危险：父 Agent 会以为 child 无法访问某个工具，实际上进程外产品仍然拥有完整工具集；或者父 Agent 期待 JSON 结果，最终只收到一段无法可靠解析的文本。

可继续对话是另一种能力。它通过可选的 `prepareContinuable()` 方法表达：方法存在就是支持，不再额外维护一个可能与实现失同步的布尔标志。

## Provider 选择属于部署，不属于模型

一个看似灵活的设计，是给模型一个通用工具：

```json
{
  "provider": "codex",
  "prompt": "检查这个改动"
}
```

DeepSeek Harness 没有这样做。一个面向模型的委派工具固定绑定一个 provider；如果要暴露多个后端，就注册多个名称不同的工具。

```text
subagent_fast         → spawn
subagent_with_context → fork
subagent_codex        → codex
subagent_claude_code  → claude-code
```

这样做有三个好处：

- 每个工具的描述可以准确说明后端能力和成本；
- 产品是否安装、如何认证属于宿主配置，不变成模型参数；
- 权限策略可以按工具控制，不需要在通用执行期再次解释 provider 字符串。

服务层仍然允许多个 provider 共存；只是模型看到的是部署者已经选择并命名的能力入口。

## Spawn 与 fork 为什么是两个 Provider

“是否继承父上下文”也可以设计成请求里的 `fork: true`，但两种 child 的成本和语义差异足够大，值得成为独立 provider。

### Spawn：从空白会话开始

Spawn child 有自己的 Session、身份和持久化谱系，但不复制父级 transcript。父 Agent 必须在任务中提供足够的上下文。

它适合：

- 可以写成自包含提示词的任务；
- 需要长期继续对话的 child；
- 不希望历史噪声进入新任务的场景。

### Fork：继承已完成的父级历史

Fork child 用父会话中已经完成且结构平衡的轮次作为种子。进行中的轮次不会复制，因为当前那次 subagent 调用还没有结果，把它带进 child 会制造无法回放的工具调用。

它适合需要理解完整讨论背景的短期任务，还可能获得 provider 侧的提示词前缀复用。但继承历史也意味着每次 child 请求都携带额外 token 成本。

当前随附组合让 fork child 保持 one-shot。可继续 child 会增加仅属于 child 的工具和系统提示，这些内容位于继承消息之前，会破坏原本希望复用的逐字节请求前缀。Spawn 没有继承前缀，因此仍适合可继续模式。

## 父日志只保留委派边界

进程内 child 也拥有独立 Session，而不是把全部步骤写入父日志。父会话只看到两件事：

1. 发起委派的 `tool/call`；
2. child 的最终输出或明确失败形成的 `tool/result`。

Child 内部的模型轮次、工具调用和中间证据留在 child 自己的日志中。

这种隔离避免父上下文被子任务细节淹没，同时仍然保留可追踪谱系。进程内 child 的 header 记录 `parentSession`；远程 provider 没有本地 child Session，只返回父级作用域内的生命周期 id。

“独立日志”并不等于“完全隔离权限”。进程内 child 仍共享宿主进程和服务，因此必须在委派边界显式固定策略，而不能假设独立 Session 自动形成安全边界。

## 委派时收窄权限，而不是复制父级批准能力

进程内 child 会捕获父会话当前显式的沙箱覆盖，但审批策略被固定为 `never`。如果 child 尝试请求更宽的沙箱访问，系统确定性拒绝，而不是弹出一个没有人负责回答的权限提示。

这遵循一个重要原则：

> 委派可以继承已经授予的范围，但不能继承替父级继续申请权限的权力。

这些策略作为 child 自己的会话事件写入，因此恢复时可以只依赖 child 日志重建，不需要重新读取父 Agent 的当前状态。父级后来改变策略，也不会追溯修改一个已经创建的持久 child。

进程外 provider 还多一层边界：子进程默认不能继承父进程中形似凭证的环境变量。Child 所需密钥必须在 provider 配置中显式加入，避免把无关的云密钥、token 或密码一起泄露给外部产品。

## 后端差异留在哪里

统一 seam 不应该假装所有后端完全相同。它统一的是生命周期，不是抹平能力差异。

| Provider | 上下文 | 运行位置 | 典型特征 |
|---|---|---|---|
| `spawn` | 全新 | 同进程 | 开销低，可应用工具/persona/深度限制 |
| `fork` | 父级已完成历史 | 同进程 | 适合短期上下文任务，可复用请求前缀 |
| `acp` | 全新任务 | 新 ACP 子进程 | 标准协议，独立工具与权限环境 |
| `codex` | 全新任务 | Codex app-server 进程 | 使用官方产品协议和原生设置 |
| `claude-code` | 全新任务 | Agent SDK 管理的产品进程 | 使用官方 SDK、CLI 和原生设置 |

ACP、Codex 和 Claude Code 都是一次性 provider：每次调用启动新进程和独立对话，只把最终答案或明确失败返回父级。它们不复制父 transcript，不暴露中间工具卡片，也不承诺可继续会话。

产品后端各自负责把原生终止事实映射到共享结果：`completed`、`max-tokens`、`refusal`、`aborted` 或 `error`。没有准确对应语义时应映射为 `error`，而不是编造一个成功结果。

## 完全停稳比返回结果更重要

外部产品可能启动自己的子进程树。收到最终文本只证明产品给出了答案，不代表进程、管道和监听器已经退出。

因此结果和释放是两个独立观察面：

- `result` 描述 child 做成了什么；
- `dispose()` 证明剩余工作已经取消，整棵受管进程树已经退出。

结果失败和清理失败也必须分别保留。若模型调用失败，同时进程树又无法正常退出，只报告其中一个会隐藏真实问题。

这也是为什么直接调用模型 HTTP 不能替代真实 Codex 或 Claude Code provider 测试：HTTP 可以验证模型回答，却不能验证官方产品配置、协议、权限、取消和进程清理。

## 如何接入一个新的 Provider

接入新后端时，可以按下面的顺序定义边界。

### 1. 先声明能力

- 是否继承父级对话？
- 能否强制结构化输出、深度、工具限制和 persona？
- 是 one-shot，还是能创建可继续 child？
- 工作目录和权限由谁提供？

无法强制的能力标记为不支持，不要在 adapter 中尽力而为。

### 2. 划清发布点

明确什么状态表示 child 已经真实存在。发布之前的所有失败必须完全回滚；发布之后的失败必须通过稳定 run id 和终止结果呈现。

### 3. 定义终止映射

将原生完成、拒绝、上下文耗尽、用户取消、协议错误和进程错误映射到封闭的共享结果。未知状态默认失败，不默认成功。

### 4. 证明资源释放

- 取消是否传播到原生协议？
- 是否能终止整棵进程树，而不只是直接 child？
- `dispose()` 是否幂等？
- 启动一半失败时，是否残留句柄或进程？

### 5. 分层测试真实边界

- 脚本化 provider：穷尽能力、结果与竞态；
- 真实协议或真实产品的无密钥回环测试：证明官方集成路径；
- Loader 组合测试：证明公开配置能够实际加载；
- 带密钥 E2E：证明真实模型链路，但不替代前面的确定性测试。

判断抽象是否合格，可以问一句：新增后端时，Agent loop 是否需要知道它的协议？如果答案是需要，传输细节仍然泄漏到了委派核心。

## 延伸阅读

- [Subagent 能力 seam](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-06-21-subagent-capability-seam.zh.md)
- [ACP Subagent 后端](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-06-22-acp-subagent-backend.zh.md)
- [Claude Code 与 Codex Subagent 后端](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)
- [Fork child 保持 one-shot](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-08-10-fork-children-stay-one-shot.zh.md)
- [Subagent 包说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/packages/subagent/subagent/README.zh.md)
