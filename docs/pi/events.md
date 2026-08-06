---
title: 事件系统源码走读
description: 一条 AgentEvent 从循环发出后，如何扇出到扩展、UI 和会话文件
---

# 事件系统源码走读

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，主要文件 `packages/coding-agent/src/core/agent-session.ts`、`event-bus.ts`。**代码块左侧行号与仓库真实行号一致**。
:::

[agent loop](/pi/agent-loop) 里所有对外输出都走同一个出口：`await emit(event)`。循环不知道事件去了哪，只知道**要等它处理完**。这篇讲「哪」——一条事件从循环发出后经过了什么，以及为什么顺序是那个顺序。

## 事件的三层

```text
┌─ agent-core ──────────────────────────────────────────┐
│  runLoop()  ──►  await emit(AgentEvent)               │
│                        │                              │
│                  Agent.processEvents()                │
│                    ├ 更新 Agent 自己的 state          │
│                    └ for (l of listeners) await l(e)  │
└────────────────────────┼──────────────────────────────┘
                         ▼
┌─ coding-agent ────────────────────────────────────────┐
│  AgentSession._handleAgentEvent(event)                │
│    ① 同步队列状态（必须最先）                          │
│    ② await 扩展                                        │
│    ③ 通知会话监听者（同步，不 await）                   │
│    ④ 写会话文件                                        │
└───────────────────────────────────────────────────────┘
                         ▼
┌─ 自由通道 ─────────────────────────────────────────────┐
│  EventBus：扩展之间的发布订阅，与 agent 生命周期无关     │
└───────────────────────────────────────────────────────┘
```

三层的**耦合强度是递减的**：第一层是硬契约（`AgentEvent` 联合类型，改一个字段全链路编译报错），第二层是应用编排，第三层是字符串 channel 的松散广播。

## 1. 队列状态必须比事件先更新

<p class="code-caption"><code>packages/coding-agent/src/core/agent-session.ts</code> · <code>_handleAgentEvent()</code></p>

```ts:line-numbers=610
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}
```

场景是这样的：用户在 agent 干活时又输了一句，这句进 steering 队列，UI 上显示成一条「排队中」的灰条。等循环真的把它注入上下文时，会发出 `message_start`。

如果先把 `message_start` 抛给 UI 再清队列，UI 会有一帧同时显示「排队中的那句」和「已发出的那句」——同一句话出现两次。所以这段清理**必须跑在任何 emit 之前**，注释里直接写明了 `BEFORE emitting`。

::: warning 这里的匹配是靠文本内容
`indexOf(messageText)` —— 队列里存的是字符串，靠内容找。所以连着发两条一模一样的消息时，删掉的是最早那条。对这个场景够用（两条内容相同的消息，先删哪条没有可观察差别），但它是一处结构性的将就，不是精确的 id 匹配。
:::

## 2. 扩展先行，且被 await

<p class="code-caption"><code>packages/coding-agent/src/core/agent-session.ts</code> · <code>_handleAgentEvent()</code></p>

```ts:line-numbers=633
		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);
```

两行代码，两个不同的分发策略：

**扩展被 `await`。** 它们是流程的一部分——一个扩展可能要在 `turn_end` 时往上下文里塞东西，或者在 `agent_end` 前做收尾。让它们跑完再往下走。代价是慢扩展会拖慢整个 agent，这是接受的。

**会话监听者不被 await：**

<p class="code-caption"><code>packages/coding-agent/src/core/agent-session.ts</code> · <code>_emit()</code></p>

```ts:line-numbers=563
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}
```

返回类型是 `void`，同步循环，不等任何东西。TUI、状态栏、footer 这些消费者被结构性地限制成「不许阻塞」——它们连返回 Promise 的机会都没有。

**分层的背压策略**：`agent-core` 那层 `await` 每个监听者（详见 [agent loop](/pi/agent-loop)）；到了这一层，扩展继承了这个 await，UI 则被挡在同步边界外。想阻塞 agent，你得是扩展。

::: tip agent_end 被就地增强了
`{ ...event, willRetry: ... }` —— 从 `agent-core` 收到的 `agent_end` 只说「循环结束了」，但 AgentSession 知道更多：这次是不是要自动重试。UI 需要这个才能决定显示「完成」还是「正在重试」。

**事件在向下传递的过程中携带的信息是增加的**，`AgentSessionEvent` 是 `AgentEvent` 的超集，多出 `queue_update`、`auto_retry_end` 这类纯应用层事件。
:::

## 3. 持久化挂在 message_end 上

<p class="code-caption"><code>packages/coding-agent/src/core/agent-session.ts</code> · <code>_handleAgentEvent()</code></p>

```ts:line-numbers=639
		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere
```

为什么是 `message_end` 而不是 `turn_end`？

因为 `message_end` 是**每条消息**（用户的、助手的、工具结果的）终态确定的那一刻。挂在这里意味着：会话文件的写入顺序严格等于消息产生顺序，而且任何时刻崩溃，已经落盘的部分都是完整消息——不会出现半条流式消息。

再回顾 [agent loop](/pi/agent-loop) 里的设计：流式过程中 partial 消息就地替换上下文数组末尾，只有终态才发 `message_end`。**两边配合，才使得「事件驱动的持久化」是安全的。**

三类消息走三条路：

| 消息类型 | 去向 |
|---|---|
| `custom`（扩展产生） | `appendCustomMessageEntry`，带上 `customType` 和渲染信息 |
| `user` / `assistant` / `toolResult` | `appendMessage`，标准 LLM 消息 |
| `bashExecution` / `compactionSummary` / `branchSummary` | 不在这里，各自的产生点自己写 |

第三类的注释值得注意——**它明确说了「这里不管」**。这种注释比沉默强得多：读代码的人不会以为是漏了。

## 4. 扩展事件是重新构造的，不是转发

<p class="code-caption"><code>packages/coding-agent/src/core/agent-session.ts</code> · <code>_emitExtensionEvent()</code></p>

```ts:line-numbers=727
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
```

注意它**没有**写成 `this._extensionRunner.emit(event)` 一行转发，而是逐个类型重新构造。

原因是扩展看到的事件带着 `agent-core` 不知道的信息：`turnIndex`（第几轮）、`timestamp`。`agent-core` 的 `turn_start` 是个空事件（只有 `type`），轮次计数是 AgentSession 自己维护的（`agent_start` 时归零）。

**这道显式的转换层是扩展 API 的稳定性保障**：`agent-core` 的事件形状变了，改这里一处；扩展作者看到的 `TurnStartEvent` 不动。

## 5. EventBus：33 行的自由通道

<p class="code-caption"><code>packages/coding-agent/src/core/event-bus.ts</code>（全文）</p>

```ts:line-numbers=1
import { EventEmitter } from "node:events";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const safeHandler = async (data: unknown) => {
				try {
					await handler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}
```

和上面那套强类型的 `AgentEvent` 完全相反：channel 是字符串，data 是 `unknown`，谁都能发谁都能收。它服务的是**扩展之间**的通信——A 扩展想在 B 扩展做了某事时反应一下，而 `agent-core` 不该知道这两个扩展的存在。

三个细节：

**`on()` 返回退订函数**，而不是让调用方记住 handler 引用去 `off`。这是必须的——它包装出来的 `safeHandler` 和用户传进来的 `handler` 不是同一个函数对象，用户根本没法自己 off。

**handler 被 try/catch 包住，出错只打日志。** 一个扩展的 handler 抛异常，不能影响另一个扩展，更不能弄坏 agent。这里选择了「隔离 + 记录」而不是「让它炸」——因为这条总线上的订阅者互相之间没有契约。

**`safeHandler` 是 async 但 `emit` 不等它。** `emitter.emit()` 同步返回，handler 的 promise 无人 await。所以这条总线是**真正的 fire-and-forget**，与 `AgentEvent` 那条「每一步都 await」的链路形成鲜明对比。

::: tip 为什么值得有两套机制
`AgentEvent` 那套要保证顺序和持久化正确性，所以处处 await、强类型、单一分发点。
`EventBus` 服务的是插件生态，要的是**不认识对方也能通信**，且任何一方出错不牵连别人。
用同一套机制覆盖两种需求，结果一定是两边都别扭。
:::

## 一条事件的完整旅程

以「助手回复完一条消息」为例：

```text
1. anthropic-messages.ts    收到 message_stop，构造最终 AssistantMessage
2. agent-loop.ts            emit({ type: "message_end", message })   ← 开始 await
3. Agent.processEvents      messages.push(message)（更新 Agent state）
4. AgentSession             ① 队列检查（本例无关，跳过）
5.                          ② await 扩展 → 扩展可以在这里做任何事
6.                          ③ 同步通知 UI → TUI 重绘这条消息
7.                          ④ sessionManager.appendMessage() → 写 JSONL
8. agent-loop.ts            await 返回，循环继续判断有没有工具调用
```

第 2 步那个 `await` 一直等到第 7 步完成。**整条链路是串行的**，这是刻意的：会话文件的顺序、UI 的顺序、扩展看到的顺序，三者严格一致。

代价是任何一环变慢，agent 就跟着变慢。这也解释了为什么 [工具执行](/pi/tools) 那篇里 bash 的流式输出必须做 100ms 限流——不限流的话，这条串行链路每秒要跑几百遍。

## 四条不变式

1. **状态先于通知。** 队列清理跑在 emit 之前，避免 UI 看到不一致的中间态。
2. **能阻塞 agent 的只有扩展。** UI 监听者的签名是 `void`，从类型上就没法参与背压。
3. **事件向下传递时信息只增不减。** `AgentEvent` → `AgentSessionEvent`（加 `willRetry`）→ 扩展事件（加 `turnIndex`、`timestamp`）。
4. **两套机制服务两种需求。** 强类型串行链路管正确性，字符串松散总线管插件互通。

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `core/event-bus.ts` | 33 | 全文即上文，五分钟读完 |
| `agent/src/types.ts` | 437 | `AgentEvent` 联合类型的完整定义与文档 |
| `core/session-manager.ts` | 1714 | 事件落盘之后：append-only 的 JSONL 会话树 |
| `core/extensions/runner.ts` | 1236 | 扩展事件真正被分发的地方 |
