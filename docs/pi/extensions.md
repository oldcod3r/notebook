---
title: 扩展系统源码走读
description: pi coding-agent 的自扩展能力：一个函数、33 个事件、四种分发策略
---

# 扩展系统源码走读

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，包 `packages/coding-agent/src/core/extensions/`。**代码块左侧行号与仓库真实行号一致**。
:::

README 把 pi 称作「self extensible coding agent」。这句话的实际重量在这四个文件里：

| 文件 | 行数 | 职责 |
|---|---|---|
| `types.ts` | 1718 | 接口定义。扩展能看到什么、能改什么 |
| `runner.ts` | 1236 | 分发。事件怎么给出去、返回值怎么合并 |
| `loader.ts` | 713 | 加载。一个 `.ts` 文件怎么变成能跑的模块 |
| `wrapper.ts` | 45 | 把扩展注册的工具包成 `AgentTool` |

**1718 行接口定义，只为支撑一个类型。** 先看这个类型。

## 1. 一个扩展就是一个函数

<p class="code-caption"><code>core/extensions/types.ts</code></p>

```ts:line-numbers=1510
/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export type InlineExtension =
	| ExtensionFactory
	| {
			/** Display name shown as `<inline:name>` in the startup Extensions list. */
			name: string;
			factory: ExtensionFactory;
			/** Omit this extension from the startup Extensions list. */
			hidden?: boolean;
	  };
```

没有基类、没有生命周期方法、没有 manifest 里声明能力。一个扩展就是**默认导出一个函数**，函数拿到 `pi` 对象，在里面注册想注册的东西，返回。

```ts
// 一个完整的扩展
export default (pi) => {
	pi.on("tool_call", (event) => {
		if (event.tool === "bash" && event.input.command.includes("rm -rf /")) {
			return { block: true, reason: "Refused: destructive command" };
		}
	});
};
```

所有状态都靠闭包保存。没有 `this`，没有实例，没有需要实现的接口。**注册即能力**——没调 `pi.registerTool()` 的扩展就没有工具，不需要在别处声明。

## 2. 加载：jiti，以及三种运行时

<p class="code-caption"><code>core/extensions/loader.ts</code> · <code>loadExtensionModule()</code></p>

```ts:line-numbers=412
async function loadExtensionModule(extensionPath: string, cacheToken?: ExtensionCacheToken) {
	if (isCurrentCacheToken(cacheToken)) {
		const cachedFactory = extensionCache.get(extensionPath);
		if (cachedFactory) {
			return cachedFactory;
		}
	}

	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		// Bun uses modules embedded in the executable. Source TypeScript reuses the
		// host-resolved modules and root tsconfig paths. Built Node uses dist aliases.
		...(isBunBinary
			? { virtualModules: VIRTUAL_MODULES, tryNative: false }
			: isTypeScriptSourceRuntime
				? { virtualModules: VIRTUAL_MODULES, tsconfigPaths: true }
				: { alias: getAliases() }),
	});

	const module = await jiti.import(extensionPath, { default: true });
	const factory = module as ExtensionFactory;
	if (typeof factory !== "function") {
		return undefined;
	}
	if (isCurrentCacheToken(cacheToken)) {
		extensionCache.set(extensionPath, factory);
	}
	return factory;
}
```

用户写的是 **TypeScript**，不用编译，直接被 `jiti` 加载。这是扩展体验的关键——扔一个 `.ts` 到 `.pi/extensions/` 就能跑，不需要 build 步骤。

那个三分支的三元表达式是这个系统最脏也最必要的地方，pi 有三种发行形态，每种的模块解析方式都不同：

| 运行时 | 问题 | 解法 |
|---|---|---|
| **Bun 单文件二进制** | 依赖被打进可执行文件，磁盘上不存在 | `virtualModules` 把它们喂给 jiti，`tryNative: false` 禁掉原生解析 |
| **TypeScript 源码运行**（`./pi-test.sh`） | 依赖在 monorepo 的 node_modules 里 | `tsconfigPaths: true` 复用根 tsconfig 的路径映射 |
| **构建后的 Node 包** | 代码在 `dist/`，扩展写的是包名 | `alias` 把 `@earendil-works/pi-ai` 映射到实际 dist 路径 |

**扩展作者对这三种情况一无所知**，永远只写 `import { ... } from "@earendil-works/pi-ai"`。这个三元表达式就是「让同一份扩展代码在三种发行形态下都能跑」的全部成本。

`moduleCache: false` 配合外层自己维护的 `extensionCache`：缓存的粒度是「工厂函数」而不是「模块」，且带 `cacheToken`（cwd + generation）。切换项目或重载扩展时 generation 递增，旧缓存自然失效。

## 3. 加载即执行，失败即隔离

<p class="code-caption"><code>core/extensions/loader.ts</code> · <code>loadExtension()</code></p>

```ts:line-numbers=466
async function loadExtension(
	extensionPath: string,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	cacheToken?: ExtensionCacheToken,
): Promise<{ extension: Extension | null; error: string | null }> {
	const resolvedPath = resolvePath(extensionPath, cwd, { normalizeUnicodeSpaces: true });

	try {
		const factory = await loadExtensionModule(resolvedPath, cacheToken);
		time(`${extensionPath} module import`, "extensions");
		if (!factory) {
			return { extension: null, error: `Extension does not export a valid factory function: ${extensionPath}` };
		}

		const extension = createExtension(extensionPath, resolvedPath);
		const api = createExtensionAPI(extension, runtime, cwd, eventBus);
		await factory(api);
		time(`${extensionPath} factory`, "extensions");

		return { extension, error: null };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { extension: null, error: `Failed to load extension: ${message}` };
	}
}
```

三步：先给这个扩展造一个**空的收纳盒**（`createExtension` 里全是空 Map：handlers、tools、commands、flags、shortcuts），再造一个**绑定到这个盒子的 API**，然后调工厂函数——扩展往 `pi` 上注册什么，就落进它自己那个盒子。

于是「哪个能力来自哪个扩展」是天然可追溯的，出错时能报出具体路径。`createExtension` 里还生成了 `sourceInfo`，UI 上显示能力来源就靠它。

返回类型是 `{ extension, error }` 而不是抛异常——**一个扩展加载失败不能拖垮整个启动过程**，其余扩展照常加载，失败的那个在启动列表里标红。

## 4. ExtensionAPI：33 个 on() 重载

<p class="code-caption"><code>core/extensions/types.ts</code> · <code>ExtensionAPI</code>（节选）</p>

```ts:line-numbers=1236
	on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
	on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
```

整个 `ExtensionAPI` 里 `on()` 有 **33 个重载**，覆盖会话生命周期、agent 生命周期、消息、工具、模型切换、用户输入、项目信任。全部靠字面量类型区分——写 `pi.on("tool_call", ...)` 时，handler 的参数类型和返回值类型都被精确推导出来。

除了 `on()`，`ExtensionAPI` 还有四类方法：

| 类别 | 方法 | 说明 |
|---|---|---|
| **注册能力** | `registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` | 工具、斜杠命令、快捷键、CLI 参数 |
| **接管渲染** | `registerMessageRenderer` / `registerMarkdownTransformer` / `registerEntryRenderer` | 自定义消息类型怎么画 |
| **主动行为** | `sendMessage` | 扩展可以自己往会话里发消息、甚至触发新一轮 |
| **换掉模型层** | `registerProvider` | 见第 8 节 |

## 5. 返回值就是干预能力

事件 handler 的返回类型不是装饰，**每一个都对应一种具体的干预**：

<p class="code-caption"><code>core/extensions/types.ts</code> · Event Results</p>

```ts:line-numbers=1065
export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
}

/** Result from user_bash event handler */
export interface UserBashEventResult {
	/** Custom operations to use for execution */
	operations?: BashOperations;
	/** Full replacement: extension handled execution, use this result */
	result?: BashResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
	usage?: Usage;
}

export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	message?: AgentMessage;
}
```

对照 [agent loop](/pi/agent-loop) 那篇会发现，这些正是循环里那几个钩子的对外投影：

| 扩展返回 | 落到循环的哪里 |
|---|---|
| `ToolCallEventResult.block` | `beforeToolCall` 的 `{ block: true }` → 工具不执行，返回错误结果 |
| `ToolResultEventResult` | `afterToolCall` 的字段级覆盖 |
| `ContextEventResult.messages` | `transformContext`，发请求前替换上下文 |
| `UserBashEventResult.operations` | [工具执行](/pi/tools) 那篇的 `BashOperations` 注入 |

::: tip 注意 tool_call 那条注释
> Block tool execution. **To modify arguments, mutate `event.input` in place instead.**

改参数和拦截走的是两条完全不同的路：拦截靠返回值，改参数靠**就地改事件对象**。这是个刻意的不对称设计——如果改参数也走返回值，多个扩展各返回一份修改后的参数，合并策略会立刻变成难题。就地改则天然是「按顺序依次加工」。
:::

## 6. 分发策略一：错误隔离

<p class="code-caption"><code>core/extensions/runner.ts</code> · <code>emit()</code></p>

```ts:line-numbers=801
	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionPath: ext.path,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}
```

通用路径：**每个 handler 单独 try/catch，出错记账继续**。错误带上 `extensionPath` 和 `stack` 发出去，UI 能明确告诉用户「是哪个扩展炸了」。

`session_before_*` 这类事件多一条：任何一个扩展返回 `cancel: true` 就**立刻返回**，不再问后面的扩展。一票否决——要取消这次 fork/switch/compact，问一个人就够了。

## 7. 分发策略二：链式改写

<p class="code-caption"><code>core/extensions/runner.ts</code> · <code>emitMessageEnd()</code></p>

```ts:line-numbers=835
	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("message_end");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							extensionPath: ext.path,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
```

改写类事件走的是**管道**：上一个扩展的输出是下一个扩展的输入（第 846 行重新构造 `currentEvent`）。多个扩展可以叠加处理同一条消息，顺序即优先级。

中间那道 `role` 校验是唯一的硬约束：可以改内容，**不能改角色**。因为角色决定了这条消息在上下文里的位置和持久化方式，改了会破坏下游一切假设。违规不会抛异常，而是记错误 + `continue`——**丢弃这次修改，保留上一版**。

`modified` 标志让返回值区分「没人改」和「改了但结果碰巧相同」，调用方据此决定要不要走替换路径。

## 8. 分发策略三：fail closed

<p class="code-caption"><code>core/extensions/runner.ts</code> · <code>emitToolCall()</code></p>

```ts:line-numbers=932
	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}
```

::: danger 这个方法没有 try/catch，而它上下的方法都有
`emit()` 有、`emitUserBash()` 有、`emitMessageEnd()` 有，唯独 `emitToolCall()` 没有。**这不是遗漏。**

`tool_call` 是权限扩展的挂载点。一个负责拦截危险命令的扩展如果在判断过程中抛了异常，「记个日志继续」意味着**这次危险调用被放行了**——安全检查失败等于没检查。

不 catch，异常就一路冒到 [agent loop](/pi/agent-loop) 的 `prepareToolCall`。那里的 try/catch 会把它变成一条错误型 tool result，工具**不会执行**。

`emitError` 的语义是「出错了，继续」；抛出去的语义是「出错了，别做」。安全路径必须选后者。
:::

`block` 同样是一票通过即返回——第一个说不的扩展说了算，后面的不用再问。

## 9. 上下文给的是副本

<p class="code-caption"><code>core/extensions/runner.ts</code> · <code>emitContext()</code></p>

```ts:line-numbers=984
	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		const ctx = this.createContext();
		let currentMessages = structuredClone(messages);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
```

`structuredClone(messages)` —— 扩展拿到的是**深拷贝**。

原因很实际：`context` 事件在每次发请求前触发，扩展在这里做 RAG 注入、裁剪历史、脱敏。如果给的是真数组，一个扩展手滑 `messages.pop()` 就永久删掉了会话历史——而这条修改本该只影响这一次请求。

给副本的代价是每轮多一次深拷贝；收益是**扩展的错误不会污染会话状态**。同样是「隔离优先于性能」的取舍。

## 10. 扩展甚至能换掉模型层

<p class="code-caption"><code>core/extensions/types.ts</code> · <code>ExtensionAPI</code></p>

```ts:line-numbers=1411
	registerProvider(provider: Provider): void;
	registerProvider(name: string, config: ProviderConfig): void;
```

两个重载对应两种深度：

- 传一个完整的 `Provider`（[pi-ai](/pi/pi-ai) 那篇里 `createProvider` 的产物）——自己实现协议、认证、模型目录
- 传一份 `ProviderConfig` 声明式配置——指定 `baseUrl` / `apiKey` / `api` / `models`，pi 用现成的协议实现帮你拼

第二种覆盖了绝大多数需求：公司内网的 LLM 网关、自建代理、给现有 provider 换个 baseUrl。`examples/extensions/` 下的 `custom-provider-anthropic` 和 `custom-provider-gitlab-duo` 就是这么写的。

**这条 API 让扩展的能力边界超出了「插件」的常规范围**——它能替换掉整个模型接入层，而 [agent loop](/pi/agent-loop) 完全不知道自己在跟一个扩展注册的 provider 说话。

## 11. 自扩展：工具可以装出新工具

回到 [agent loop](/pi/agent-loop) 里那个当时没展开的字段：

```ts
/** Names of tools introduced by this result and available from this transcript point onward. */
addedToolNames?: string[];
```

一个工具执行完，可以在结果里声明「我引入了这些新工具」。从这条记录往后的对话，模型就能调用它们。

配合扩展系统，这条路径是完整的：扩展注册一个 `load_skill` 工具 → 模型调用它 → 该工具动态注册新工具并在结果里返回 `addedToolNames` → 后续轮次里模型能用这些新工具。**agent 在运行过程中长出了新能力**，这就是 "self extensible" 的字面意思。

## 五条不变式

1. **注册即能力，无声明。** 没有 manifest，扩展跑一遍工厂函数，注册了什么就有什么。
2. **每个扩展有独立的收纳盒。** 能力来源天然可追溯，报错能指名道姓。
3. **默认隔离错误，安全路径例外。** `emitError` 记账继续是常态；`tool_call` 故意让异常冒出去，fail closed。
4. **改写类事件走管道，否决类事件走短路。** 前者顺序即优先级，后者第一票即终局。
5. **给扩展的可变数据一律是副本。** 扩展的 bug 不该污染会话状态。

## 四篇的合流

到这里 pi 的主干走完了。五篇串起来是一条完整的因果链：

```text
pi-ai        把 46 家厂商的差异压平成一条事件流
   ↓
agent loop   消费事件流，驱动「模型说话 → 工具干活」的循环
   ↓  ↘
工具执行      循环调度的那一端：可替换后端、截断即引导、按文件排队
   ↓
事件系统      循环的输出去向：队列 → 扩展 → UI → 会话文件
   ↓
扩展系统      在上面每一个环节插手的能力，以及注册新 provider / 新工具
```

一个观察：**这五层里，每一层都有一处「故意不 catch」或「故意 catch」的决定**，而且每次的理由都不同。

| 层 | 决定 | 理由 |
|---|---|---|
| pi-ai | `lazyStream` 一律 catch 转成流事件 | 上层敢不写 try/catch |
| agent loop | 工具异常一律接住变成错误结果 | 模型有机会自己纠正 |
| 工具执行 | `onUpdate` 迟到的调用静默丢弃 | 事件顺序不能靠运气 |
| 事件系统 | `EventBus` handler 出错只打日志 | 订阅者之间没有契约 |
| 扩展系统 | `emitToolCall` **不** catch | 安全检查失败必须等于拒绝 |

错误处理策略不是一条全局规则，是**每个边界各自的产物**。

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `extensions/types.ts` | 1718 | 想写扩展的话，这是唯一需要读的文件 |
| `examples/extensions/` | 78 个 | 可直接抄的例子，从 20 行的 hello 到完整的沙箱、子 agent、贪吃蛇 |
| `extensions/runner.ts` | 1236 | 十种 `emit*` 方法，每种的合并策略都不一样 |
| `coding-agent/docs/containerization.md` | — | 扩展能力的极限：把工具执行整个搬进微虚拟机 |
