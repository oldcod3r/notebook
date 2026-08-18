# 内容索引

### 决策与知识管理

1. **[Agent Note：用决策生命周期管理技术知识](./agent-note-lifecycle.md)**：让设计记录沿 `proposed → implemented / rejected → archived` 演进，并保留问题、备选方案与取舍。

### Agent 运行时

2. **[基于事件溯源的 Agent 会话设计](./event-sourced-sessions.md)**：用仅追加事件日志支撑消息派生、回放、fork 和持久化。
3. **[Subagent 能力抽象与多后端共存](./subagent-provider-seam.md)**：统一进程内、ACP、Codex 与 Claude Code 等委派后端。
4. **[后台 Subagent 的任务模型](./background-subagent-jobs.md)**：处理异步执行、通知、取消、归属和资源释放。
5. **[可继续对话的持久化 Subagent](./continuable-subagent-sessions.md)**：分离持久 child session 与短期 activation/run。
6. **[长对话的上下文压缩机制](./context-compaction.md)**：覆盖 token 压力、摘要、历史替换、检查点和失败恢复。
7. **[Skill 系统与渐进式指令披露](./progressive-skill-disclosure.md)**：把发现元数据与完整指令分离，控制上下文成本。

### 安全与工具执行

8. **[Agent 沙箱与最小权限升级](./sandbox-and-escalation.md)**：默认受限执行，在真实拒绝后请求一次性授权。
9. **[审批机制：机制与策略分离](./approval-routing.md)**：让权限请求正确路由，并在无人应答时 fail closed。
10. **[工具调用的安全并行调度](./parallel-tool-scheduling.md)**：由工具按调用参数声明并发安全性。
11. **[工具取消与副作用边界](./cooperative-tool-cancellation.md)**：区分“收到取消”与“工作已经完全停稳”。

### 测试与工程实践

12. **[真实模型 API 的 E2E 测试](./real-api-e2e.md)**：隔离无密钥 CI 与可信事件上的真实模型门禁。
13. **[Agent 工程中的文档写作方法](./agent-prose-standard.md)**：只保留可验证的契约、边界和无法由代码表达的理由。
14. **[清理工程文档中的推理过程泄漏](./reasoning-leakage.md)**：把面向评审过程的思维记录改写成面向仓库当前状态的知识。
15. **[面向 Agent 项目的代码审查](./agent-code-review.md)**：检查生命周期、取消、权限、持久化、文档和真实运行证据。

## 选材原则

- 优先采用仍然有效的 `implemented` 记录；被替代的记录只用于补充设计演进。
- `proposed` 内容明确标注为提案，不写成已经交付的事实。
- `archived` 只作历史背景，不把冻结实现描述为当前权威行为。
- 删除项目私有路径、临时审查上下文和无法脱离仓库理解的实现细节。
- 每篇都回到一个可迁移的问题：这个设计解决了什么，为什么没有选择更直观的方案，代价是什么。
