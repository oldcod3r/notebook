---
title: 工具执行源码走读
description: pi coding-agent 的七个内置工具：可替换的执行后端、截断策略、并发写入
---

# 工具执行源码走读

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，包 `packages/coding-agent/src/core/tools/`。**代码块左侧行号与仓库真实行号一致**，caption 标注了各自来自哪个文件。
:::

[agent loop](/pi/agent-loop) 那篇讲了工具**怎么被调度**——预检串行、执行并行、结果按源序排列。这篇讲工具本身：七个内置工具（`read` / `bash` / `edit` / `write` / `grep` / `find` / `ls`）是怎么写的，以及三个反复出现的设计。

先看这三个设计，后面所有代码都在为它们服务：

| 设计 | 解决什么问题 |
|---|---|
| **`Operations` 注入** | 让同一个工具能在本地跑、也能在沙箱或远程机器上跑 |
| **截断即引导** | 输出太长时不是砍掉了事，而是告诉模型「下一步怎么拿到剩下的」 |
| **按文件串行** | 工具并行执行，但同一个文件的写入必须排队 |

## 1. 工具的执行后端是可以换掉的

<p class="code-caption"><code>packages/coding-agent/src/core/tools/read.ts</code></p>

```ts:line-numbers=39
/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};
```

每个工具都把「真正碰系统的那几个动作」抽成一个 `Operations` 接口，默认实现就是本地文件系统。`bash` 的版本更极端，只有一个方法：

<p class="code-caption"><code>packages/coding-agent/src/core/tools/bash.ts</code></p>

```ts:line-numbers=52
/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}
```

**这就是 README 里说的三种容器化方案的挂载点。** Gondolin 扩展把 `exec` 换成「把命令送进本地 Linux 微虚拟机执行」，工具的参数校验、输出截断、TUI 渲染全部原样复用——它只替换了最下面那一层。

pi 自身不内置权限系统（README 明说了）。它给的是两个替换点：[agent loop](/pi/agent-loop) 里的 `beforeToolCall` 负责**拦**，这里的 `Operations` 负责**改道**。

## 2. 两副面孔：ToolDefinition 与 AgentTool

`agent-core` 只认识 `AgentTool`——名字、schema、`execute`，没有任何 UI 概念。但 CLI 需要工具知道怎么在终端里画自己。于是 coding-agent 定义了更肥的 `ToolDefinition`（多出 `renderCall` / `renderResult` / `promptSnippet` / `promptGuidelines`），再降级：

<p class="code-caption"><code>packages/coding-agent/src/core/tools/tool-definition-wrapper.ts</code></p>

```ts:line-numbers=4
/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		constrainedSampling: definition.constrainedSampling,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate, ctx?: ExtensionContext) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctx ?? (ctxFactory?.() as ExtensionContext)),
	};
}
```

注意 `execute` 那一行多塞了第五个参数 `ctx`。`AgentTool.execute` 的签名只有四个参数——**多出来的这个是 coding-agent 的私货**，通过闭包注入，`agent-core` 完全不知道它的存在。工具靠它拿到当前模型（判断支不支持图片）、扩展上下文等信息。

同文件还有反向的 `createToolDefinitionFromAgentTool()`：用户用扩展写的裸 `AgentTool` 被补齐成 `ToolDefinition`，这样 AgentSession 内部只需要维护一种注册表。

## 3. 截断不是砍掉，是给模型下一步指令

<p class="code-caption"><code>packages/coding-agent/src/core/tools/read.ts</code> · <code>execute()</code></p>

```ts:line-numbers=287
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
```

四个分支，每一个都在回答同一个问题：**「我没给全，你想要剩下的该怎么做」**。

- 普通截断 → 告诉它确切的 `offset=N`，不用自己算
- 单行就超限（压缩过的 JS、minified 文件）→ 直接给一条可以照抄的 `sed | head` 命令
- 用户自己传了 `limit` 但文件还有内容 → 提示还剩多少行

对比一下「输出被截断，请重试」这种写法：模型只能猜。而这里每条提示都是**可以直接照做的动作**。这是给 LLM 写工具和给人写 CLI 的根本区别——错误信息的读者是一个会照着执行的程序。

::: tip read 和 bash 的截断方向是相反的
`read` 用 `truncateHead`（保留开头），因为你要的是文件前面那部分。
`bash` 用 `truncateTail`（保留结尾），因为编译错误、测试失败、堆栈都在输出末尾。
同一套 `truncate.ts`，两个方向。
:::

## 4. bash：杀进程要杀整棵树

<p class="code-caption"><code>packages/coding-agent/src/core/tools/bash.ts</code> · <code>createLocalBashOperations()</code></p>

```ts:line-numbers=96
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};
```

三个细节都是踩出来的：

**`detached: true`。** 让子进程独立成组，这样 `killProcessTree` 才能按进程组一次性干掉整棵树。如果只 kill shell 自己，`npm run build` 起的一堆子进程会变成孤儿继续跑——用户按了 Esc，编译还在后台烧 CPU。

**`trackDetachedChildPid` / `untrackDetachedChildPid`。** 全局登记在跑的 PID，pi 进程退出时兜底清理。detached 的代价就是它不会跟着父进程死，得自己记账。

**`stdio` 第一位是 `"ignore"`（或 `"pipe"` 后立刻 `end`）。** 不给命令留 stdin。否则一个等待输入的交互式命令（`git rebase -i`、`npm login`）会永久挂住，而 agent 那边看起来就是「卡住了」。

再往下 `waitForChildProcess(child)`（第 133 行）而不是简单监听 `close`——注释说明了原因：detached 的后代可能继承了 stdio 句柄，等 `close` 会一直等到那些后代也退出。

## 5. 流式输出要限流，因为事件是被 await 的

<p class="code-caption"><code>packages/coding-agent/src/core/tools/bash.ts</code> · <code>execute()</code></p>

```ts:line-numbers=362
			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};
```

`BASH_UPDATE_THROTTLE_MS` 是 **100**（第 200 行）。

为什么必须限流？回到 [agent loop](/pi/agent-loop) 里的一条不变式：**每个事件都被 `await`**。`onUpdate` 最终会走到 `emit({ type: "tool_execution_update" })`，而循环会等所有监听者处理完——包括 TUI 重绘一屏。

一条 `npm test` 每秒可能吐几百个 chunk。不限流的话就是每秒几百次全屏重绘，终端直接卡死。这里的做法是标脏 + 定时合并：100ms 内的所有输出攒成一次更新。

`updateTimer ??= setTimeout(...)` 这个写法保证同时只有一个待触发的定时器——已经排上队了就不再排。

## 6. 完整输出落盘，只把路径给模型

<p class="code-caption"><code>packages/coding-agent/src/core/tools/bash.ts</code> · <code>formatOutput()</code></p>

```ts:line-numbers=404
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};
```

输出超限时，**完整内容被写进临时文件，路径塞进给模型的文本里**。

这一步很关键：模型看到 `Full output: /tmp/pi-bash-xxx.log` 之后，可以自己决定下一步——`grep -n "error" /tmp/pi-bash-xxx.log` 只捞它关心的那几行。信息没有丢，只是从「塞进上下文」变成了「按需检索」。

用几百 token 的路径提示，换掉几万 token 的日志正文。

## 7. 工具并行跑，但同一个文件排队

<p class="code-caption"><code>packages/coding-agent/src/core/tools/file-mutation-queue.ts</code></p>

```ts:line-numbers=28
/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
```

这是 [agent loop](/pi/agent-loop) 并行执行的另一半。循环那边的策略是「有一个工具声明 sequential 就整批串行」——那是粗粒度的一票否决。这里是细粒度补充：**按文件加锁，不同文件照样并行。**

三个值得学的点：

**锁的 key 是 `realpath`**（`getMutationQueueKey`，第 16 行）。两个不同的符号链接指向同一个文件时，字符串路径不同但 realpath 相同——共用一条队列。文件不存在时（新建）退回到 `resolve()` 后的绝对路径。

**`registrationQueue` 是「给注册过程本身加的锁」。** 因为算 key 要 `await realpath`，这中间 map 可能被别的调用改掉，导致两个操作都以为自己是队首。所以注册动作先串成一条链。

**链式 promise 而不是布尔锁。** 每个操作往队尾挂一个 `nextQueue`，等前一个 `currentQueue` resolve 后才开跑，跑完 `releaseNext()` 放行下一个。天然 FIFO，不需要显式的等待队列。

最后那句 `if (fileMutationQueues.get(key) === chainedQueue) delete` 是防泄漏：只有当自己仍是队尾时才清理 map 条目，否则会把后来者的队列删掉。

## 8. 工厂函数：定义与实例分开

<p class="code-caption"><code>packages/coding-agent/src/core/tools/index.ts</code></p>

```ts:line-numbers=138
export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, options?.edit),
		createWriteToolDefinition(cwd, options?.write),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, options?.read),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
	];
}
```

工具不是单例，是**按 `cwd` 和 `options` 现造的**。所以同一个进程里可以有多个 agent 会话，各自绑在不同的工作目录、各自用不同的执行后端。

`createReadOnlyToolDefinitions` 是给子 agent 用的预设——只读工具集，天然不会改文件。**权限在这里表现为「你拿到哪几个工具」，而不是运行时检查。**

## 贯穿工具层的四条不变式

1. **碰系统的动作全部走 `Operations`。** 这是沙箱、远程执行、测试替身的唯一挂载点。
2. **截断必须附带下一步动作。** `offset=N`、`sed` 命令、临时文件路径——读者是一个会照做的程序。
3. **流式更新必须限流。** 事件被 `await`，不限流等于让 UI 给 agent 拖后腿。
4. **并发粒度分两层。** 粗粒度看工具声明（sequential 一票否决），细粒度按文件 realpath 排队。

## 和其它两篇的接缝

| 接缝 | 工具层 | 别处 |
|---|---|---|
| **谁能拦住工具** | `Operations` 改道 | [agent loop](/pi/agent-loop) 的 `beforeToolCall` 拦截 |
| **并发安全** | 按文件 realpath 排队 | [agent loop](/pi/agent-loop) 的 `executionMode: "sequential"` |
| **流式更新** | 100ms 限流 | [agent loop](/pi/agent-loop) 里 `onUpdate` 生命周期被关死 |

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `tools/file-mutation-queue.ts` | 61 | 61 行讲清楚了一个正确的按键排队器 |
| `tools/truncate.ts` | 276 | 行数限制与字节限制同时生效时怎么算 |
| `tools/edit-diff.ts` | 560 | 编辑工具的匹配与差异呈现，全套工具里最难的一个 |
| `tools/output-accumulator.ts` | 222 | 边流边攒、超限落盘的缓冲区 |
