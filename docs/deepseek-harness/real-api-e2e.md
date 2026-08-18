# 真实模型 API 的 E2E 测试

无密钥测试可以证明事件管线、工具协议和错误分支，却无法证明真实模型服务、真实流式传输和真实产品进程能一起工作。

DeepSeek Harness 曾出现过典型事故：大量无密钥测试保持绿色，真实 ACP 客户端会话却在启动后立即崩溃。替身忠实地模拟了预期协议，却没有覆盖真实集成中的导出和装配事实。

因此真实 API E2E 不是“更慢的单元测试”，而是另一种证据层级。

## 无密钥 CI 与真实 API 门禁职责不同

| 无密钥 CI | 真实 API E2E |
|---|---|
| 可供 fork 和外部贡献者运行 | 只在可信事件上运行 |
| 快速、确定、无 Secret | 消耗额度，依赖外部服务 |
| 穷尽错误与竞态分支 | 证明真实模型和协议链路 |
| 失败通常是代码回归 | 还可能是凭证或服务故障 |

把两者塞进同一个 workflow 会耦合触发策略和凭证生命周期。更清晰的做法是独立工作流：默认 CI 永远不携带 Secret，真实 E2E 只运行需要真实服务的测试。

## 自动 skip 会制造“假绿”

测试常用下面的保护：没有 API key 就 skip。这对本地开发友好，但在声称“真实 API 已验证”的 CI 中非常危险。

如果 workflow 忘了注入 Secret，测试套件会全部跳过并返回绿色。绿色只证明命令成功启动，没有证明任何真实请求发生。

真实 E2E 工作流需要 preflight：

```text
Secret 缺失 → 明确失败
Secret 存在 → 运行且仅运行真实 E2E
```

测试内部仍可保留本地 skip，但受信 CI 必须在进入测试前把缺失凭证变成硬失败。

## 只在可信事件上暴露 Secret

外部 fork 的 PR 代码不应在持有仓库 Secret 的上下文中执行。真实 E2E 的触发条件必须限制到可信分支、受控手动运行或经过明确批准的事件。

不要使用会在特权上下文检出并执行不可信 PR 代码的组合。仓库从私有转公开时，还要重新审查触发器、维护者权限和第三方 Action 的供应链范围。

凭证只通过运行时环境传入：

- 不写入配置文件、快照或测试报告；
- 不打印 header 和环境变量；
- 不把请求载荷与密钥一起持久化；
- 子进程只获得它明确需要的 Secret。

## 真实 E2E 应验证完整产品行为

一个有价值的 Agent E2E 不只是向模型发送“你好”。它应覆盖产品真正依赖的链路：

- 真实模型调用与流式完成；
- 工具调用和结果回传；
- 多轮次与恢复；
- ACP/stdin 等真实传输；
- 取消、上下文上限和 stop reason；
- 真实产品进程的启动与完全退出。

测试答案最好使用每次运行生成的随机 nonce，要求模型或回环端点原样返回。固定 `PONG` 容易被缓存、fixture 或错误路由意外满足。

## 真实产品测试与真实 API 测试也不同

Codex/Claude Code provider 需要至少三层证据：

1. 脚本化 adapter 测试：穷尽协议分支；
2. 无密钥真实产品回环测试：启动官方产品，验证原生配置与进程生命周期；
3. 带密钥真实 API E2E：经过生产 provider、官方产品和真实模型服务。

直接 HTTP 调用真实模型只能覆盖第 3 层的一部分，无法证明官方产品的设置、审批、工具和清理。产品替身也无法证明官方发行版真的能启动。

## 外部不稳定性如何处理

真实服务会限流、超时或短暂不可用。不能用无限重试把失败冲淡，也不能把所有失败都归咎于外部。

建议：

- 使用有限、可观察的重试；
- 保留 provider 错误代码和请求阶段，不记录敏感载荷；
- 将服务可用性失败与断言失败分类；
- 让测试规模足够小，避免自身制造限流；
- 对成本和并发设置明确上限；
- 定期确认测试确实发出了真实请求。

## 一套可审计的工作流结构

```text
trusted trigger
  → checkout exact commit
  → install from lockfile
  → preflight required Secret
  → run only *.e2e tests
  → assert at least one real case executed
  → upload sanitized diagnostics
```

每次失败都应能回答：执行的是哪个 commit、哪条真实链路、是否实际调用了 provider、失败发生在产品启动、传输、模型还是清理阶段。

## 落地检查清单

- 无密钥 CI 不接触生产 Secret。
- 真实 E2E 使用独立 workflow 和可信触发。
- 缺失 Secret 明确失败，不能全部 skip 后报绿。
- 测试断言至少一个真实 case 执行。
- 凭证只存在于运行时，不进入日志和产物。
- 使用唯一答案证明请求没有被 fixture 假满足。
- 验证进程树、连接和临时资源完全释放。
- 外部失败有限重试并保留阶段化诊断。
- 仓库可见性或触发策略变化时重新做威胁评审。

## 延伸阅读

- [在 CI 中运行真实 DeepSeek API E2E](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/testing/2026-06-19-real-api-e2e-ci.zh.md)
- [Claude Code 与 Codex Subagent 后端](https://github.com/deepseek-ai/deepseek-harness/blob/47f943859bef60e4160492346772ded9b24f765a/.agents/notes/implemented/feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md)
