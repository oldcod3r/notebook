---
title: pi-ai 源码走读
description: pi 的多厂商 LLM 统一层，46 个 provider 与 10 种协议如何解耦
---

# pi-ai 源码走读

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，包 `packages/ai/`。**代码块左侧行号与仓库真实行号一致**，caption 标注了各自来自哪个文件。
:::

[agent loop](/pi/agent-loop) 那篇里，循环调的是一个叫 `streamFn` 的东西，然后就不管了——它不知道下面是 Anthropic 还是 Ollama。这篇讲的就是「下面」：46 家厂商、10 种线上协议，最后收敛成一个函数签名。

先看一组数字，整包的设计命门都在里面：

| | 行数 |
|---|---|
| `providers/openai.ts` | **15** |
| `providers/groq.ts` | **15** |
| `providers/deepseek.ts` | **15** |
| `api/anthropic-messages.ts` | 1351 |
| `api/openai-completions.ts` | 1547 |
| `api/openai-codex-responses.ts` | 1650 |

**加一家新厂商是 15 行，加一种新协议是一千多行。** 这不是巧合，是刻意把两件事拆成了两个维度。

## 1. 一个 provider 到底是什么

<p class="code-caption"><code>packages/ai/src/providers/openai.ts</code>（全文）</p>

```ts:line-numbers=1
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_MODELS } from "./openai.models.ts";

export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
		models: Object.values(OPENAI_MODELS),
		api: openAIResponsesApi(),
	});
}
```

这就是 OpenAI 支持的全部代码。一个 provider 被拆成了四样东西：

- **`id` / `baseUrl`** —— 往哪发
- **`auth`** —— 凭证怎么来（这里是读环境变量）
- **`models`** —— 卖哪些模型（生成的目录文件）
- **`api`** —— 说哪种协议

其中只有 `api` 是重的，而它被 46 家厂商共享。所以「支持 Groq」这件事的真实成本是：确认它说 OpenAI Completions 协议，然后写 15 行。

::: tip 类型上的一个小心思
返回类型是 `Provider<"openai-responses">`，协议名被编进了类型参数。后面 `Model<TApi>` 的 `compat` 字段会按这个 `TApi` 条件展开成不同的兼容性配置类型——写错协议的兼容开关是编译期错误。
:::

## 2. createProvider：把「模型 → 协议」的分发关死

<p class="code-caption"><code>packages/ai/src/models.ts</code> · <code>createProvider()</code></p>

```ts:line-numbers=775
	const single =
		typeof (input.api as ProviderStreams).stream === "function" ? (input.api as ProviderStreams) : undefined;
	const byApi = single ? undefined : (input.api as Partial<Record<string, ProviderStreams>>);

	const apiFor = (model: Model<Api>): ProviderStreams | undefined => single ?? byApi?.[model.api];

	const dispatch = (
		model: Model<Api>,
		run: (streams: ProviderStreams) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const streams = apiFor(model);
		if (!streams) {
			return lazyStream(model, async () => {
				throw new ModelsError("stream", `Provider ${input.id} has no API implementation for "${model.api}"`);
			});
		}
		return run(streams);
	};
```

`api` 字段可以是**一个**协议实现，也可以是一张 `协议名 → 实现` 的表。为什么需要后者？因为有些厂商同时提供多套 API——比如 OpenRouter 上既有 Anthropic 系模型也有 OpenAI 系模型，Bedrock 更是一个网关下挂几家。这时 provider 是一个，协议是多个，按 `model.api` 分发。

::: warning 注意 dispatch 里的失败处理
找不到协议实现时，它**不抛异常**，而是返回一个「立刻以错误终止的流」。这是 pi-ai 全包最核心的纪律：一旦进入流式接口，所有失败都必须以流事件的形式出现。这条纪律是 [agent loop](/pi/agent-loop) 敢于几乎不写 try/catch 的前提。
:::

## 3. 所有协议模块长得一模一样

<p class="code-caption"><code>packages/ai/src/types.ts</code> · <code>ProviderStreams</code></p>

```ts:line-numbers=264
export interface ProviderStreams {
	stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream;
	streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	fetchDeferred?(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: DeferredFetchOptions,
	): AssistantMessageEventStream;
	cancelDeferred?(model: Model<Api>, handle: DeferredHandle, options?: DeferredCancelOptions): Promise<void>;
}
```

`src/api/` 下每个模块都导出 `stream` 和 `streamSimple`，所以**模块本身就满足这个接口**，不需要额外包装类。

两个方法的分工值得留意：

- **`stream`** 收厂商原生参数（`AnthropicOptions`、`GoogleOptions`……），强类型，给需要精细控制的调用方
- **`streamSimple`** 收统一参数 `SimpleStreamOptions`，里面只有 `reasoning`、`maxTokens`、`temperature` 这类跨厂商都有的概念

agent loop 只用 `streamSimple`。**「统一」这件事的代价被限制在一个方法里，而不是抹平整个 API。**

## 4. Models.streamSimple：三步走

<p class="code-caption"><code>packages/ai/src/models.ts</code> · <code>ModelsImpl.streamSimple()</code></p>

```ts:line-numbers=690
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return lazyStream(model, async () => {
			const provider = this.requireProvider(model);
			const { requestModel, requestOptions } = await this.applyAuth(model, options);
			return provider.streamSimple(requestModel, context, requestOptions as SimpleStreamOptions);
		});
	}
```

`Models` 这一层只做三件事：找到拥有该模型的 provider、解析认证、把请求转交下去。**它不碰任何协议细节。**

认证解析这一步藏着几个实用设计：

<p class="code-caption"><code>packages/ai/src/models.ts</code> · <code>applyAuth()</code></p>

```ts:line-numbers=644
		const resolution = await this.getAuth(model, {
			apiKey: options?.apiKey,
			env: options?.env,
			signal: options?.signal,
		});
		if (!resolution) {
			throw new ModelsError("auth", `Provider is not configured: ${model.provider}`);
		}
		const auth = resolution.auth;

		// Explicit request options win per-field; the Models-only transform runs last.
		const apiKey = options?.apiKey ?? auth.apiKey;
		let headers = mergeHeaders(auth.headers, options?.headers);
		if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {});
		const env = resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;
		const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		const { transformHeaders: _transformHeaders, ...providerOptions } = options ?? {};
		const requestOptions = { ...providerOptions, apiKey, headers, env } as Omit<TOptions, "transformHeaders"> &
			ProviderRequestOptions;
```

- **认证可以改写 `baseUrl`**（第 659 行）。OAuth 登录后拿到的可能是一个和默认地址不同的端点，这里把模型对象浅拷贝一份改掉，而不是污染全局模型目录。
- **逐字段覆盖，显式参数赢**。调用方传的 `apiKey`、`headers` 优先于凭证存储里的。
- **`transformHeaders` 最后跑**，且用完就从透传参数里剥掉——它是 `Models` 层的概念，不该漏给 provider。

## 5. lazyStream：契约的强制执行点

<p class="code-caption"><code>packages/ai/src/api/lazy.ts</code></p>

```ts:line-numbers=41
/**
 * Returns a stream synchronously while running async setup (auth resolution,
 * lazy module loading) behind it. Setup failures terminate the stream with an
 * error event.
 */
export function lazyStream(
	model: Model<Api>,
	setup: () => Promise<AsyncIterable<AssistantMessageEvent>>,
): AssistantMessageEventStream {
	const outer = new AssistantMessageEventStream();

	setup()
		.then((inner) => forwardStream(outer, inner))
		.catch((error) => {
			const message = createSetupErrorMessage(model, error);
			outer.push({ type: "error", reason: "error", error: message });
			outer.end(message);
		});

	return outer;
```

这 20 行同时解决了两个问题。

**第一，同步返回一个流，异步做准备工作。** 调用方拿到 `outer` 时，认证还没解析、协议模块可能还没加载。但签名是同步的，调用方可以立刻 `for await` 上去。准备工作在后台跑完后，内层流的事件被 `forwardStream` 转发进来。

**第二，把「不许抛异常」这条契约变成结构性保证。** 注意那个 `.catch()`：任何准备阶段的失败——provider 没配、模块加载失败、凭证过期——都被转成一条 `stopReason: "error"` 的 assistant 消息，从流里发出去。

`createSetupErrorMessage`（第 4 行）构造的是一条**内容为空但字段完整**的 assistant 消息：`api`、`provider`、`model`、`usage` 全填好，`content: []`。下游拿到的永远是一条结构合法的消息，不需要判空。

::: tip 惰性加载不只是为了启动速度
同文件的 `lazyApi()` 把动态 `import()` 包成 `ProviderStreams`，协议模块在第一次调用时才加载。46 个 provider 的目录数据加上 10 个协议实现，全量加载会让 CLI 启动明显变慢——而一次会话通常只用到一个协议。
:::

## 6. 协议适配器：把 SSE 翻译成统一事件

到这里才进入那一千多行的世界。协议适配器的工作是：消费厂商的 SSE 流，一边**就地拼装**一条 `AssistantMessage`，一边往外发标准事件。

<p class="code-caption"><code>packages/ai/src/api/anthropic-messages.ts</code> · <code>content_block_start</code></p>

```ts:line-numbers=587
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: event.content_block.text ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: event.content_block.thinking ?? "",
							thinkingSignature: event.content_block.signature ?? "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
```

几个值得注意的细节：

**两套索引。** Anthropic 的 `event.index` 是它自己的内容块编号，pi 的 `contentIndex` 是 `output.content` 数组的下标。两者不保证一致，所以每个 block 里临时存一个 `index` 字段用于回查，最后再 `delete` 掉。

**`redacted_thinking` 被折叠成普通 thinking。** 上游把被安全系统抹掉的推理内容作为一个独立类型返回，pi 把它归一成 `thinking` 加一个 `redacted: true`，正文填 `[Reasoning redacted]`。**统一层的活儿就是把 N 种上游形状压成一种下游形状**，代价是丢失一点信息——这里用一个布尔位保留住了。

**OAuth 模式下工具名要翻译**（`fromClaudeCodeName`）。用 Claude Pro/Max 订阅登录时，上游期待的是 Claude Code 那套工具名，出入都得转一道。

## 7. 每个 delta 都重新解析一次 JSON

<p class="code-caption"><code>packages/ai/src/api/anthropic-messages.ts</code> · <code>input_json_delta</code></p>

```ts:line-numbers=654
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
```

工具参数是一个字符一个字符流过来的 JSON 片段。为了让 UI 能实时显示「它正准备写哪个文件」，每收到一段就把**累积的、不完整的** JSON 重新解析一次。

<p class="code-caption"><code>packages/ai/src/utils/json-parse.ts</code> · <code>parseStreamingJson()</code></p>

```ts:line-numbers=104
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}
```

四级降级，一级比一级不挑：

1. 标准 `JSON.parse`
2. 修复后再 parse —— `repairJson()` 处理两类模型高频犯的错：字符串里混进裸控制字符、反斜杠后跟非法转义符
3. `partial-json` 的容错解析 —— 专门处理「结构没写完」，自动补全缺失的引号和括号
4. 修复 + 容错一起上
5. 还不行就返回 `{}`

**这个函数永远不抛异常，永远返回一个对象。**

::: danger 这里正是 agent loop 那条防御的另一半
在 [agent loop](/pi/agent-loop) 里有一段：`stopReason === "length"` 时整批工具调用直接判错，注释说「参数可能解析成功、schema 校验也过，但内容是残缺的」。

残缺的东西为什么能解析成功？就是因为这里。第 3 级的 `partial-json` 会把 `{"file_path": "/etc/passwd", "content": "首行` 补成一个**合法对象**——`content` 字段有值，只是只有一半。schema 校验只看类型，看不出语义上的残缺。

所以两个包各守一头：pi-ai 负责「尽量给出可显示的东西」，agent-core 负责「知道什么时候不能拿它当真」。**单看任何一边都会觉得对方多余。**
:::

`content_block_stop` 时会再解析一次（第 695 行），然后 `delete block.partialJson` —— 把流式过程中的脚手架字段抹掉，让最终落进会话历史的消息干干净净。

## 8. 24 条正则，只为判断「上下文超了」

<p class="code-caption"><code>packages/ai/src/utils/overflow.ts</code> · <code>OVERFLOW_PATTERNS</code></p>

```ts:line-numbers=37
const OVERFLOW_PATTERNS = [
	/prompt is too long/i, // Anthropic token overflow
	/request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
	/input is too long for requested model/i, // Amazon Bedrock
	/exceeds the context window/i, // OpenAI (Completions & Responses API)
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
	/input token count.*exceeds the maximum/i, // Google (Gemini)
	/maximum prompt length is \d+/i, // xAI (Grok)
	/reduce the length of the messages/i, // Groq
	/maximum context length is \d+ tokens/i, // OpenRouter (most backends)
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
	/exceeds the limit of \d+/i, // GitHub Copilot
	/exceeds the available context size/i, // llama.cpp server
	/greater than the context length/i, // LM Studio
	/context window exceeds limit/i, // MiniMax
	/exceeded model token limit/i, // Kimi For Coding
	/too large for model with \d+ maximum context length/i, // Mistral
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i, // DS4 server
	/model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
	/prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
	/range of input length should be/i, // DashScope / Qwen Token Plan
	/context[_ ]length[_ ]exceeded/i, // Generic fallback
	/too many tokens/i, // Generic fallback
	/token limit exceeded/i, // Generic fallback
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 400/413 with no body
];
```

这份清单没有任何设计感，它就是被现实磨出来的。「输入超过上下文窗口」是所有 LLM API 都会遇到的错误，而**没有任何两家用同样的措辞**，也没有任何一家给出稳定的错误码。Cerebras 更狠——直接返回 400/413，body 是空的。

紧接着还有一份**反向清单**：

<p class="code-caption"><code>packages/ai/src/utils/overflow.ts</code> · <code>isContextOverflow()</code></p>

```ts:line-numbers=134
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
	// Case 1: Check error message patterns
	if (message.stopReason === "error" && message.errorMessage) {
		// Skip messages matching known non-overflow patterns (e.g. throttling / rate-limit)
		const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!));
		if (!isNonOverflow && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))) {
			return true;
		}
	}

	// Case 2: Silent overflow (z.ai style) - successful but usage exceeds context
	if (contextWindow && message.stopReason === "stop") {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens > contextWindow) {
			return true;
		}
	}

	// Case 3: Length-stop overflow (Xiaomi MiMo style) - server truncates oversized input
	// to fit the context window, leaving no room for output. Returns stopReason "length"
	// with output=0 and input+cacheRead filling the context window.
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		const inputTokens = message.usage.input + message.usage.cacheRead;
		if (inputTokens >= contextWindow * 0.99) {
			return true;
		}
	}

	return false;
}
```

三条检测路径，对应三种上游行为：

| 情况 | 上游表现 | 怎么认出来 |
|---|---|---|
| 1. 报错 | 大多数厂商 | 正则匹配错误文本，先排除限流类误报 |
| 2. **不报错** | z.ai 静默接受 | `stopReason: "stop"` 但 `usage.input > contextWindow` |
| 3. 装作输出完了 | 小米 MiMo | 截断输入填满窗口，返回 `length` 且 `output === 0` |

情况 2 和 3 是这段代码里最贵的知识——**它们只能靠实际打出来才能发现**。而 `NON_OVERFLOW_PATTERNS` 的存在同样说明问题：Bedrock 的限流错误写作 "Too many tokens, please wait"，会命中通用的 `/too many tokens/i`，不排除掉就会把限流误判成上下文溢出，触发一次毫无意义的上下文压缩。

## 9. compat：从 URL 猜这家到底是谁

`Model` 上有个 `compat` 字段，装着一堆兼容性开关。以 OpenAI Completions 协议为例，有 **25 个**：`supportsStore`、`supportsDeveloperRole`、`maxTokensField`、`requiresToolResultName`、`thinkingFormat`（11 种取值）……

问题在于：用户在 `settings.json` 里加一个自定义 OpenAI 兼容端点时，不会填这些。于是有了这个：

<p class="code-caption"><code>packages/ai/src/api/openai-completions.ts</code> · <code>detectCompat()</code></p>

```ts:line-numbers=1417
function detectCompat(model: Model<"openai-completions">): ResolvedOpenAICompletionsCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
```

**靠 URL 子串猜厂商。** 看起来很脏，但这是唯一可行的办法——用户配了个 `https://api.together.ai/v1`，pi 得知道这家要用 `max_tokens` 而不是 `max_completion_tokens`，不然请求直接 400。

再往下有个概念叫 `isNonStandard`，把「虽然自称 OpenAI 兼容但实际上不支持 `store` 字段」的一票厂商归成一类。然后：

```ts
maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
```

一行代码，背后是七家厂商各自的实测结果。

**这就是「OpenAI 兼容」四个字的真相：协议名字是一样的，字段集合各不相同。** 显式的 `model.compat` 永远优先于猜测——猜测只是给没人工标注过的自定义端点兜底。

## 10. 能力归一化：请求 high，模型只有 low 怎么办

<p class="code-caption"><code>packages/ai/src/models.ts</code> · <code>clampThinkingLevel()</code></p>

```ts:line-numbers=913
export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}
```

思考等级有七档 `off / minimal / low / medium / high / xhigh / max`，但每个模型支持的子集都不一样（`thinkingLevelMap` 里 `null` 表示不支持）。

降级策略是**先向上找，再向下找**：请求 `high` 而模型只有 `off / medium / max` 时，先往上找到 `max`，而不是退到 `medium`。

这个方向选择是有道理的——用户明确要求更多思考时，**宁可给多也不给少**。只有上面完全没有可用档位时才向下退。

## 11. 成本：按整个请求的输入量分档

<p class="code-caption"><code>packages/ai/src/models.ts</code> · <code>calculateCost()</code></p>

```ts:line-numbers=878
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCostRates = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}
```

两个容易算错的地方，注释里都点明了：

- **分档是整请求生效的，不是超出部分。** 输入超过阈值后，**全部** token 按高档价算，不是「前 200k 按低价、超出部分按高价」。所以循环找的是「所有已越过的阈值里最高的那个」。
- **1 小时缓存写入按基础输入价的 2 倍计费**，和普通缓存写入不是一个价。所以 `cacheWrite` 要拆成 `longWrite` / `shortWrite` 两段分别算。

这个函数在流式过程中被反复调用（`message_start` 一次、每个 `message_delta` 一次），因为它是**就地改写** `usage.cost`，UI 能实时看到花了多少钱。

## 贯穿全包的五条不变式

1. **进了流式接口就不许抛异常。** `lazyStream` 是这条规则的物理执行点，`createProvider` 的 dispatch、`Models` 的认证失败全走它。
2. **provider 和 protocol 是两个维度。** 加厂商 15 行，加协议一千行，两者不互相污染。
3. **统一的代价被限制在 `streamSimple` 一个方法里。** 需要厂商原生能力时走 `stream`，类型完整。
4. **上游的形状差异在适配器里被压平，且尽量不丢信息。** `redacted_thinking` 折叠成 `thinking + redacted: true` 就是范例。
5. **兼容性知识是资产，写进代码而不是文档。** 24 条溢出正则、25 个 compat 开关、URL 猜厂商——这些是实际打过接口才拿得到的东西。

## 和 agent loop 的接缝

两个包在三个点上咬合，理解了这三处就理解了分层：

| 接缝 | pi-ai 侧 | agent-core 侧 |
|---|---|---|
| **流契约** | `lazyStream` 保证不抛异常 | 循环里几乎没有 try/catch |
| **不完整的工具参数** | `parseStreamingJson` 尽力给出可显示的对象 | `stopReason === "length"` 时整批判错 |
| **上下文压力** | `isContextOverflow` 识别三种上游行为 | `prepareNextTurn` 里换上压缩后的上下文 |

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `packages/ai/src/api/lazy.ts` | 98 | 全包最小、最关键的文件 |
| `packages/ai/src/utils/overflow.ts` | 180 | 一份用真金白银换来的厂商行为清单 |
| `packages/ai/src/types.ts` | 815 | `compat` 那几个 interface 是「OpenAI 兼容」的实际定义 |
| `packages/ai/src/api/anthropic-messages.ts` | 1351 | 一个完整协议适配器的全貌 |
