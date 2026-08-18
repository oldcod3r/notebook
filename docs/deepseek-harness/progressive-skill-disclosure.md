# Skill 系统与渐进式指令披露

Agent 可以使用的项目规范、审查流程和工具说明越来越多。如果把所有指令全文塞进每次请求，模型会为大量不相关内容支付 token，真正与当前任务有关的规则反而更难被注意。

Skill 系统采用两阶段披露：**初始上下文只公布名称与描述，模型判断匹配后，再按名称加载完整正文和所需资源。**

## 目录不是正文

第一阶段目录保持极小：

```text
code-review — 审查变更的正确性、生命周期和安全边界
translate-docs — 更新双语文档并验证配对
record-browser-gif — 录制真实 UI 操作证据
```

它回答“有哪些能力可能适用”，不包含完整步骤、文件路径、provider 或资源列表。完整 `SKILL.md` 只有在模型调用 loader 时才进入当前历史。

这带来两个成本优势：

- 每次请求只承担短目录的固定 token；
- 一个复杂 Skill 的参考资料和示例仅在实际需要时加载。

目录描述因此必须能独立完成路由：太泛会导致频繁误加载，太长又破坏渐进式披露。

## 注册表、Provider 与消费方分离

Skill 来源不只有文件系统。它可能来自项目目录、用户目录、随包资源、repository 插件或远程服务。

| 层 | 责任 |
|---|---|
| Registry | 合并 provider、校验候选、解决重名、生成稳定目录 |
| Provider | 发现并读取某一来源的 Skill |
| Consumer | 向模型注入目录并提供按名加载工具 |

文件扫描不应写死在 registry 中。这样远程 Skill 可以在不修改消费方的前提下加入；内置 Skill 也无需启动时写入用户主目录。

## 层级比全局排名更重要

宿主级 Skill 与 preset/project 级 Skill 可以同名。DeepSeek Harness 采用作用域分层：最近层直接遮蔽远层，rank 只在同一层内裁决。

```text
当前 Agent scope
  ├── preset / project 层：code-review  ← 胜出
  └── 宿主全局层：code-review
```

如果把全部层放进一个 rank 池，后来安装的全局插件可能凭注册顺序顶掉项目作者明确提供的 Skill。最近层优先让局部组合保持可预测。

Registry 属于宿主，Agent 是否消费 Skill 则由 preset 决定。这两个问题不能混在一起：冷会话也需要列出部署供给的 Skill，但一个 minimal Agent 可以选择不挂载 loader 工具。

## 发现必须确定、可失效、可取消

Provider 的 `list()` 可以包含远程初始化、认证和文件扫描，因此是异步且可取消的。Registry 只缓存已经完成的目录快照；provider 注册、释放或磁盘变化会使缓存失效。

若发现期间 revision 发生变化，结果不能直接提交，否则一个刚卸载的 provider 可能被永久冻结进缓存。Registry 应重新读取当前 provider 集合再生成目录。

目录最终按名称排序；同层冲突按 rank、provider 注册顺序和 provider 内顺序确定，保证相同输入产生相同提示词前缀。

## 一个坏来源不应拖垮全部 Agent

缺失目录、不可读文件或某个 provider 的瞬时失败会警告并跳过。一个坏 Skill 不应该让所有模型请求失败。

但 provider 返回格式错误的候选项应响亮失败，因为它违反了受信接口约定。这里区分的是：

- 外部环境失败：隔离并降级；
- 实现违反内部契约：尽早暴露。

本地发现只扫描配置根下的一级 `<name>/SKILL.md` 或 `<name>.md`，不递归遍历任意深度。扁平结构让顺序、重名和资源基路径都更容易推理。

## 调用策略是独立维度

Skill 是否可被模型加载、是否可被用户显式调用，是两个不同权限：

```yaml
name: translate-docs
description: 更新双语文档
disable-model-invocation: true
user-invocable: true
```

模型目录和用户命令面板可以消费同一 registry，但应用不同策略。不能因为 Skill 存在，就默认任何调用方都能触发。

Loader 还应区分“名称不存在”和“存在但禁止模型调用”，前者可能是目录变化，后者是明确策略拒绝。

## 资源按引用加载，不枚举整包

完整 Skill 可以引用脚本、示例和资产。Registry 只提供 `resourceBase`，loader 按 Skill 明确引用加载资源，不主动枚举整个目录。

这样既控制上下文，也避免把无关文件、凭证或大型二进制暴露给模型。渐进式披露不只发生在“目录→正文”，还应继续发生在“正文→所需资源”。

## 为什么目录进入持久消息

Skill 目录以带来源的 user-role system reminder 注入会话，而不是藏在一次性系统字符串里。它因此参与事件日志、回放和上下文压缩，模型看到的能力目录可以从会话事实重建。

只有当前 Agent 的工具视图确实包含 Skill loader 时才注入目录。否则模型会看到“可以加载 Skill”的提示，却没有对应工具可用。

## 编写一个可路由 Skill

一个最小 Skill 应包含：

```yaml
---
name: code-review
description: 审查代码变更的正确性、生命周期、安全边界和验证证据。
---
```

正文负责执行约定，描述只负责路由。编写时检查：

- 名称稳定、简短，使用 kebab-case；
- 描述说明何时使用和核心任务，不复述全部步骤；
- 正文不依赖未披露的会话上下文；
- 参考资料只在任务确实需要时加载；
- 模型调用与用户调用策略显式；
- 同名覆盖行为可预测。

最后可以测量两个指标：目录在每轮占多少 token，以及模型在典型任务上是否加载正确 Skill。只优化其中一个，会得到“目录很小但路由失败”或“路由准确但提示词膨胀”的系统。

## 延伸阅读

- [Skill 系统与渐进式指令披露](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-07-05-skill-system.zh.md)
- [分层 Skill Registry](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/architecture/2026-08-09-layered-skill-registry.zh.md)
- [Skill 子系统说明](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/docs/subsystems/skills.zh.md)
