---
title: agent loop
description: pi agent harness 中 packages/agent/src/agent-loop.ts 的源码走读
---

# agent loop

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，文件 `packages/agent/src/agent-loop.ts`，共 792 行。**代码块左侧行号与仓库真实行号一致**，可以直接对着源码跳。
:::

整个 pi 项目里最该读的一个文件。它不碰文件系统、不碰终端、不知道自己在跑哪家模型——只负责一件事：把「模型说话」和「工具干活」编织成一个可以被中途干预的循环。

- **文件**：`packages/agent/src/agent-loop.ts`
- **包**：`@earendil-works/pi-agent-core`
- **上游依赖**：`@earendil-works/pi-ai`（只用到 `EventStream` 和 `validateToolArguments`）

## 控制流全景

```text
  runAgentLoop(prompts)          runAgentLoopContinue()
       └────────────┬───────────────────┘
                    ▼
  ┌── while (true) ──────────────────────────────── 外层：follow-up ──┐
  │  ┌── while (hasMoreToolCalls || pending) ─── 内层：turn ────────┐ │
  │  │   turn_start                                              │ │
  │  │   注入 pending（steering 消息）                            │ │
  │  │   streamAssistantResponse()  ← 唯一调 LLM 的地方           │ │
  │  │     ├ stopReason error/aborted ─────────────► agent_end   │ │
  │  │     └ 有 toolCall ?                                       │ │
  │  │          stopReason === "length" → 整批判错（不执行）     │ │
  │  │          否则 → executeToolCalls()  串行 / 并行           │ │
  │  │   turn_end                                                │ │
  │  │   prepareNextTurn() → 可换 context / model / thinking      │ │
  │  │   shouldStopAfterTurn() ────────────────────► agent_end   │ │
  │  │   pending = getSteeringMessages()                          │ │
  │  └─────────────────────────────────────────────────────────────┘ │
  │     getFollowUpMessages() 非空 → 回到内层，否则 break             │
  └──────────────────────────────────────────────────────────────────┘
                    ▼
                agent_end { messages }
```

## 1. 入口：两个起点，一个循环

<p class="code-caption"><code>runAgentLoop()</code> / <code>runAgentLoopContinue()</code> · agent-loop.ts</p>

```ts:line-numbers=95
export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}
```

### 「新提问」和「接着跑」是两个函数，不是一个布尔参数

`runAgentLoop` 用于用户发起一轮新对话：把 prompt 拼进上下文，并且为每条 prompt 补发 `message_start` / `message_end`，让 UI 有机会把用户消息也渲染进同一条事件流。

`runAgentLoopContinue` 用于重试或恢复：上下文里已经有 user 消息或 tool 结果了，**不再追加任何消息**，直接进循环。所以它返回的 `newMessages` 起点是空数组——只包含这次跑出来的增量。

它守住了一条硬约束：最后一条消息不能是 assistant。因为紧接着就要发请求，而所有厂商都不接受以 assistant 结尾的上下文。

::: tip 设计取舍
`newMessages` 是一个贯穿整个调用栈被**就地 push** 的数组。循环深处每产生一条消息就往里塞，最后作为 `agent_end` 的载荷返回。省掉了逐层拼接，代价是它是可变的——读代码时要留意谁在写它。
:::

## 2. 主循环骨架：内层管 turn，外层管 follow-up

<p class="code-caption"><code>runLoop()</code> · agent-loop.ts</p>

```ts:line-numbers=163
	let currentContext = initialContext;
	let config = initialConfig;
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);
```

### 入口就先捞一次 steering 队列

第 167 行：循环还没开始，先问一次「有没有待插入的消息」。因为从用户按下回车到这里，中间可能已经过了几百毫秒——用户完全可能又敲了一句。这一行让"抢跑"的输入不至于等到第一个 turn 结束才生效。

`hasMoreToolCalls` 初值是 `true`，所以内层至少跑一轮。循环条件是**或**：只要还有工具要跑、*或者*还有消息要注入，就继续。

`firstTurn` 这个开关是为了不重复发 `turn_start`——入口函数已经发过第一个了。

::: tip 两条队列的语义差
**steering** ＝「它正在干活时我又说了一句」，在当前 turn 的工具跑完后立刻插进上下文，agent 继续 working。<br>
**follow-up** ＝「等它彻底停下来再处理」。<br>
同一个队列机制，插入时机不同，交互体感完全不同。
:::

## 3. 失败即出场，以及截断保护

<p class="code-caption"><code>runLoop()</code> · agent-loop.ts</p>

```ts:line-numbers=196
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });
```

### 循环继续的唯一理由：这一轮产生了工具调用

`hasMoreToolCalls` 先被设成 `false`，只有当这条 assistant 消息里真的有 `toolCall` 块、并且这批工具没有集体要求终止时，才重新变 `true`。**模型不再调工具＝这一轮该收工了**——这就是 agent 何时停下来的全部逻辑。

::: danger 这里藏着一个真实事故
`stopReason === "length"` 意味着输出被 token 上限切断了。流式解析器为了体验会做「尽力而为的 JSON 抢救」，于是一个被截断的工具调用**参数可能解析成功、schema 校验也过**，但内容是残缺的——比如一个只写了一半的文件内容。此时执行它是破坏性的。所以这一批**全部**不执行，一律返回错误让模型重发。
:::

注意 `toolResults` 同时被 push 进 `currentContext.messages`（下一次请求要看到）和 `newMessages`（最终返回给调用方）。两个数组，两种用途。

## 4. 换挡与出口

<p class="code-caption"><code>runLoop()</code> · agent-loop.ts</p>

```ts:line-numbers=226
			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
				})
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
```

### turn 之间是唯一可以「换挡」的窗口

`prepareNextTurn` 允许宿主在下一次请求前**整体替换上下文、切模型、调 thinking 级别**。上下文压缩（compaction）就挂在这里：它把长历史换成一份摘要，然后循环若无其事地继续。模型切换也一样——同一个 agent run 可以中途从便宜模型升到贵模型。

`shouldStopAfterTurn` 是「优雅刹车」：当前 turn 完整跑完（该发的事件都发了、工具都跑完了），然后不再发起新请求。典型用途是上下文快满时主动收尾。

::: warning 顺序很重要
`prepareNextTurn` 在 `shouldStopAfterTurn` **之前**跑。所以「先尝试压缩，压缩后如果还是放不下就停」这个策略是能表达的；反过来就不行。
:::

外层 while 只做一件事：内层退出后再问一次 follow-up 队列。有货就塞进 `pendingMessages` 并 `continue`——内层的条件 `pendingMessages.length > 0` 于是又成立，agent 复活。没货就 `break`，落到最后一行发 `agent_end`。

## 5. LLM 边界：整个包里唯一发请求的地方

<p class="code-caption"><code>streamAssistantResponse()</code> · agent-loop.ts</p>

```ts:line-numbers=288
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	const response = await streamFunction(config.model, llmContext, {
		...config,
		apiKey: resolvedApiKey,
		signal,
	});
```

### 这 25 行是 pi 架构上最关键的一处解耦

循环内部**全程使用 `AgentMessage`**——它可以是标准的 user/assistant/toolResult，也可以是应用自己定义的类型：一条 UI 通知、一张状态卡片、一次模型切换记录。应用通过 TypeScript 的 declaration merging 往 `CustomAgentMessages` 里加自己的类型。

只有在**要发请求的这一刻**，`convertToLlm()` 才把它们压平成厂商认识的 `Message[]`，顺手把纯 UI 消息过滤掉。

结果就是：**「会话记录」和「模型看到的上下文」被彻底分开了**。会话文件里可以存任何东西而不污染 prompt；反过来压缩上下文也不会毁掉用户看到的历史。

::: tip 为什么 API key 每轮都重新解析
上一轮的工具可能跑了十分钟（一个 `bash` 命令、一次编译）。OAuth token 在这期间过期是常态。所以 key 不是在创建 agent 时取一次，而是**每次请求前现取**。
:::

## 6. 消费流：半成品消息就地待在上下文末尾

<p class="code-caption"><code>streamAssistantResponse()</code> · agent-loop.ts</p>

```ts:line-numbers=314
	let partialMessage: AssistantMessage | null = null;
	let addedPartial = false;

	for await (const event of response) {
		switch (event.type) {
			case "start":
				partialMessage = event.partial;
				context.messages.push(partialMessage);
				addedPartial = true;
				await emit({ type: "message_start", message: { ...partialMessage } });
				break;

			case "text_start":
			case "text_delta":
			case "text_end":
			case "thinking_start":
			case "thinking_delta":
			case "thinking_end":
			case "toolcall_start":
			case "toolcall_delta":
			case "toolcall_end":
				if (partialMessage) {
					partialMessage = event.partial;
					context.messages[context.messages.length - 1] = partialMessage;
					await emit({
						type: "message_update",
						assistantMessageEvent: event,
						message: { ...partialMessage },
					});
				}
				break;

			case "done":
			case "error": {
				const finalMessage = await response.result();
				if (addedPartial) {
					context.messages[context.messages.length - 1] = finalMessage;
				} else {
					context.messages.push(finalMessage);
				}
				if (!addedPartial) {
					await emit({ type: "message_start", message: { ...finalMessage } });
				}
				await emit({ type: "message_end", message: finalMessage });
				return finalMessage;
			}
		}
	}
```

流一开始就把 `partial` 推进 `context.messages`，之后每个增量事件**替换数组最后一位**，最后用完整消息再替换一次。上下文数组因此始终"看起来是完整的"——任何时刻被中断，末尾都是一条合法（虽然可能不完整）的 assistant 消息。这正是 abort 之后还能用 `runAgentLoopContinue` 接着跑的前提。

发给监听者的是浅拷贝 `{ ...partialMessage }`，UI 拿到的每一帧都是独立快照，不会被后续 mutation 改写。

::: tip 错误不抛，只流
注意 `"error"` 和 `"done"` 走**同一个分支**。`StreamFn` 的契约明确规定：请求失败、模型报错、被中断，都不许 reject，必须编码成流里的事件加一条 `stopReason: "error" | "aborted"` 的最终消息。所以整个循环几乎看不到 try/catch——失败是一种正常的返回值。
:::

## 7. 工具调度：串行还是并行，由「最保守的那个工具」说了算

<p class="code-caption"><code>executeToolCalls()</code> · agent-loop.ts</p>

```ts:line-numbers=411
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}
```

### 一票否决

默认是并行（`toolExecution` 默认 `"parallel"`）。但只要这一批里**有任何一个**工具声明了 `executionMode: "sequential"`，整批退化成串行。

这是必需的：一个改文件的工具和一个读同一个文件的工具并发跑，结果是不确定的。与其做细粒度的依赖分析，不如让工具自己声明"我不能和别人同时跑"，然后整批让路。**简单、保守、可预测。**

## 8. 并行执行：两种顺序，同时成立

<p class="code-caption"><code>executeToolCallsParallel()</code> · agent-loop.ts</p>

```ts:line-numbers=497
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
```

这是全文件最精细的一段。它同时维持了两个互相冲突的顺序要求：

- **预检串行。** 找工具、校验参数、跑 `beforeToolCall`（权限确认弹窗就在这里）——这些必须一个一个来，否则用户会被三个确认框同时糊脸。
- **执行并行。** 数组里存的不是结果，而是*还没调用的 thunk*（第 522 行 `push(async () => …)`），全部收集完再 `Promise.all` 一起放出去。
- **`tool_execution_end` 按完成顺序发。** 它在 thunk 内部发出，谁先跑完谁先报——UI 需要即时反馈。
- **toolResult 消息按源顺序发。** 在 `Promise.all` 之后按 `finalizedCalls` 的原始下标遍历——上下文顺序必须和 assistant 消息里的工具调用顺序严格一致，否则下一轮请求会错乱。

::: warning 被中断时
`break` 只跳出**预检**循环。已经入列的 thunk 照样会被 `Promise.all` 执行——它们各自持有 `signal`，由工具自己决定怎么响应中断。循环不替工具做这个决定。
:::

## 9. prepare：失败也是一条工具结果，不是一个异常

<p class="code-caption"><code>prepareToolCall()</code> · agent-loop.ts:606–656（节选，中间省略若干行）</p>

```ts
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{ assistantMessage, toolCall, args: validatedArgs, context: currentContext },
				signal,
			);
			if (signal?.aborted) {
				return { kind: "immediate", result: createErrorToolResult("Operation aborted"), isError: true };
			}
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		// …
		return { kind: "prepared", toolCall, tool, args: validatedArgs };
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
```

工具不存在、参数不合 schema、被钩子拦下、被中断——四种情况全部走 `kind: "immediate"`，变成一条**正常的错误型 tool result** 回到模型面前。模型于是有机会自己纠正（改参数重试、换个工具）。如果这里抛异常，整个 run 就废了。

`prepareArguments` 是留给"模型经常写错格式"的兼容垫片——比如某些模型爱把数组写成逗号分隔的字符串，在校验之前先掰回来。

::: tip beforeToolCall 是权限系统的挂载点
pi 自身不内置权限模型（README 明说了）。但 `{ block: true, reason }` 这个返回值，就是给沙箱、确认弹窗、只读模式留的口子。`reason` 会原样变成模型看到的错误文本，所以它应该写给*模型*看，不是写给人看。
:::

## 10. execute：onUpdate 回调的生命周期被严格关死

<p class="code-caption"><code>executePreparedToolCall()</code> · agent-loop.ts</p>

```ts:line-numbers=671
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await prepared.tool.execute(
			prepared.toolCall.id,
			prepared.args as never,
			signal,
			(partialResult) => {
				if (!acceptingUpdates) return;
				updateEvents.push(
					Promise.resolve(
						emit({
							type: "tool_execution_update",
							toolCallId: prepared.toolCall.id,
							toolName: prepared.toolCall.name,
							args: prepared.toolCall.arguments,
							partialResult,
						}),
					),
				);
			},
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}
```

工具通过 `onUpdate` 流式吐进度（`bash` 的实时输出就靠它）。风险在于：工具可能把这个回调存起来，在自己 resolve 之后还继续调——那时候事件流已经进入下一阶段了，迟到的 update 会造成 UI 状态错乱。

`acceptingUpdates` 开关在**成功、异常、finally 三处**都被置为 `false`。之后的调用直接静默丢弃。

而已经发出的 update 事件被收集成 `updateEvents` 并在返回前 `await`——保证所有 `tool_execution_update` 都排在 `tool_execution_end` 前面。**事件顺序不能靠运气。**

::: tip 工具的契约
类型定义里写得很直白：*执行失败请抛异常，不要把错误编码进 content*。和 `StreamFn`「绝不抛异常」正好相反——因为这里有人接。
:::

## 11. finalize：字段级覆盖，没有深合并

<p class="code-caption"><code>finalizeExecutedToolCall()</code> · agent-loop.ts</p>

```ts:line-numbers=720
	if (config.afterToolCall) {
		try {
			const afterResult = await config.afterToolCall(
				{
					assistantMessage,
					toolCall: prepared.toolCall,
					args: prepared.args,
					result,
					isError,
					context: currentContext,
				},
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createErrorToolResult(error instanceof Error ? error.message : String(error));
			isError = true;
		}
	}
```

`afterToolCall` 拿到执行结果后可以逐字段替换：给输出脱敏、截断超长内容、把错误翻译成模型更好理解的说法。`??` 的语义是**整字段替换**——传了 `content` 就是整个数组换掉，不会和原来的合并。文档里特意强调了这点，因为「部分合并」的直觉在这里是错的。

钩子自己抛异常也不会炸掉循环：结果被替换成错误 result，继续走。

::: tip terminate 是全票通过制
`shouldTerminateToolBatch()`（第 582 行）要求这一批工具结果**每一个**都 `terminate === true` 才提前结束。只要有一个工具还有话要说，agent 就继续。这避免了一个"任务完成"类工具单方面掐断另外三个还在返回数据的工具。
:::

## 12. 收尾：tool result 消息里的两处防御

<p class="code-caption"><code>createToolResultMessage()</code> / <code>emitToolResultMessage()</code> · agent-loop.ts</p>

```ts:line-numbers=773
function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		usage: finalized.result.usage,
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
```

`content ?? []` 那句注释交代了来历：扩展系统允许用户用**无类型的 JS** 写工具，TypeScript 的保证在那里失效。一个返回 `undefined` 的扩展工具，如果不在这里兜住，`null` 会一路写进会话文件、再一路发给厂商 API。在信任边界上做一次归一化，比在下游到处判空便宜得多。

`addedToolNames` 是自扩展能力的载体：**一个工具的执行结果可以往 agent 身上装新工具**，从这条记录往后的对话里就能调用。这是 pi 宣称的 "self extensible" 在循环里的落点。

最后 `emitToolResultMessage` 补发一对 `message_start` / `message_end`——tool result 和用户消息、assistant 消息走完全一样的事件形状，订阅方只需要处理一种消息生命周期。

## 七条贯穿全文件的不变式

1. **循环不抛异常。** 上游（`StreamFn`）承诺不抛，下游（工具）抛了会被接住变成错误结果。所以你几乎看不到 try/catch。
2. **循环继续的唯一理由是「上一轮有工具调用」。** 其他一切（steering、follow-up）都是往这个条件上打补丁。
3. **`AgentMessage` 只在发请求那一刻才降格成 `Message`。** 会话记录 ≠ 模型上下文。
4. **上下文数组任何时刻都是合法的。** 流式的半成品就地占位，中断后可以直接 continue。
5. **事件顺序是被显式维护的，不是自然产生的。** update 先于 end，end 按完成序，消息按源序。
6. **批量决策一律取最保守值。** 一个 sequential 工具让整批串行；terminate 要全票；截断了就整批不执行。
7. **所有扩展点都是可选回调，且都收到 `signal`。** 循环从不代替钩子决定如何响应中断。

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `packages/agent/src/types.ts` | 437 | 全是带文档的接口定义，读完就建立了完整心智模型 |
| `packages/agent/src/agent.ts` | 588 | 循环之上的状态机：transcript、事件订阅、两条队列、abort |
| `packages/ai/src/utils/event-stream.ts` | 88 | 流的原语，同时支持「边流边看」和「只要最终结果」 |
| `packages/coding-agent/src/core/tools/read.ts` | 351 | 一个完整工具长什么样 |
