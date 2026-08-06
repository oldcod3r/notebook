---
title: pi-tui
description: 一个方法的组件契约、60fps 节流，以及只重画变化行的差分渲染
---

# pi-tui

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，包 `packages/tui/`。**代码块左侧行号与仓库真实行号一致**。
:::

终端 UI 库通常有两条路：要么像 blessed 那样自建一套 widget 树和事件系统，要么像 Ink 那样把 React 搬进终端。pi-tui 两条都没走——**它的组件契约只有一个方法，返回一个字符串数组**。

没有虚拟 DOM、没有响应式、没有 reconciler。整个渲染管线是：组件吐出行 → 和上一帧逐行比对 → 只重画变了的那几行。

## 1. 组件就是「宽度进，行出」

<p class="code-caption"><code>packages/tui/src/tui.ts</code> · <code>Component</code></p>

```ts:line-numbers=20
/**
 * Component interface - all components must implement this
 */
export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/**
	 * Optional handler for keyboard input when component has focus
	 */
	handleInput?(data: string): void;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Invalidate any cached rendering state.
	 * Called when theme changes or when component needs to re-render from scratch.
	 */
	invalidate(): void;
}
```

`render(width) => string[]` 就是全部。返回的每个字符串是一整行，可以带 ANSI 转义序列（颜色、粗体）。

这个签名逼出了几个后果：

- **组件不知道自己在屏幕的哪一行。** 位置由父容器决定，组件只管产出内容。
- **宽度是传进来的，不是查出来的。** 同一个组件可以被用不同宽度渲染多次。
- **没有增量更新的概念。** 每帧全量重新生成所有行，diff 交给上层。

最后一点看起来很浪费，但终端的规模就那么大——一屏几十行、每行几百字符。全量生成的成本远低于维护一套增量更新机制的复杂度。

## 2. 组合就是拼数组

<p class="code-caption"><code>packages/tui/src/tui.ts</code> · <code>Container</code></p>

```ts:line-numbers=235
	render(width: number): string[] {
		const lines: string[] = [];
		for (const child of this.children) {
			const childLines = child.render(width);
			for (const line of childLines) {
				lines.push(line);
			}
		}
		return lines;
	}
```

容器的 `render` 就是把孩子们的行**首尾相接**。垂直布局是免费的——数组拼接天然就是从上到下。

水平布局（`HStack`）要自己处理，因为得把两个组件的第 N 行拼在一起，还要处理高度不一致和 ANSI 序列下的可见宽度计算。这就是 `utils.ts` 里 `visibleWidth` / `sliceByColumn` 那些函数存在的原因——**一个带颜色的字符串，它的 `.length` 和它在屏幕上占的格子数完全是两回事**。

## 3. 渲染请求：合并 + 60fps 节流

<p class="code-caption"><code>packages/tui/src/tui.ts</code> · <code>requestRender()</code> / <code>scheduleRender()</code></p>

```ts:line-numbers=770
	requestRender(force = false): void {
		if (force) {
			this.resetRenderState();
			if (this.renderTimer) {
				clearTimeout(this.renderTimer);
				this.renderTimer = undefined;
			}
			this.renderRequested = true;
			process.nextTick(() => {
				if (this.stopped || !this.renderRequested) {
					return;
				}
				this.renderRequested = false;
				this.lastRenderAt = performance.now();
				this.doRender();
			});
			return;
		}
		if (this.renderRequested) return;
		this.renderRequested = true;
		process.nextTick(() => this.scheduleRender());
	}

	private scheduleRender(): void {
		if (this.stopped || this.renderTimer || !this.renderRequested) {
			return;
		}
		const elapsed = performance.now() - this.lastRenderAt;
		const delay = Math.max(0, TuiBase.MIN_RENDER_INTERVAL_MS - elapsed);
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			if (this.stopped || !this.renderRequested) {
				return;
			}
			this.renderRequested = false;
			this.lastRenderAt = performance.now();
			this.doRender();
			if (this.renderRequested) {
				this.scheduleRender();
			}
		}, delay);
	}
```

`MIN_RENDER_INTERVAL_MS` 是 **16**（第 342 行）——刚好 60fps。

两条路径：

**普通请求**（`force = false`）先看 `renderRequested`，已经排队了就直接返回——**一帧内调一百次 `requestRender()` 只会渲染一次**。这很重要：模型流式吐字时，每个 token 都会触发一次请求。

然后 `process.nextTick` 让出，把同一个微任务批次里的所有变更攒到一起，再按 16ms 的节奏出帧。距上一帧不足 16ms 就延后到差额时刻。

**强制请求**（`force = true`）用于主题切换、终端尺寸变化——这些情况下缓存的行全都失效了。它 `resetRenderState()` 清掉上一帧记录，取消已排队的定时器，`nextTick` 立刻渲染，不等 16ms。

末尾那个 `if (this.renderRequested) this.scheduleRender()` 处理的是渲染过程中又来了新请求：不丢，排下一帧。

## 4. 差分：只找首尾两个变化点

<p class="code-caption"><code>packages/tui/src/tui-main-screen.ts</code> · <code>doRender()</code></p>

```ts:line-numbers=294
		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
```

**整个差分算法就这些。** 没有 LCS、没有最小编辑距离——只是逐行 `!==` 比较，记下第一个和最后一个变化的行号，然后重画这个**闭区间**。

中间没变的行也会被重画。看起来不够优化，但这是对终端的正确取舍：跳过中间的行意味着要不停地移动光标（`\x1b[nB` / `\x1b[nA`），而光标移动本身也要往终端写字节。**连续重画一段，通常比精确跳过几行更省。**

真实场景也支持这个选择：流式输出时变化集中在末尾几行、按键时集中在输入框那一行——变化天然是连续的。

`appendedLines` 那段处理纯追加：内容变长但已有行都没变（比如新增了一条消息），此时 `firstChanged` 是 -1，手动指到旧内容的末尾。

## 5. 同步输出：让一帧原子地出现

差分算完之后，所有要写的转义序列被拼进一个字符串缓冲，两端包着：

```text
\x1b[?2026h   ... 一整帧的输出 ...   \x1b[?2026l
```

这是**同步输出模式**（DEC private mode 2026）。开启后终端暂停刷新，直到收到结束序列才把这一帧整体呈现出来。

不用它的话，终端会边收边画，用户能看到光标乱跳、局部撕裂——尤其在重画范围大的时候。这是终端 UI 里少有的、能直接消除闪烁的手段。

`this.terminal.write(buffer)` **整帧一次写出**，也是同一个考虑：多次小写入会给终端更多机会在中间刷新。

## 6. 什么时候放弃差分

`doRender()` 里散布着若干 `fullRender(...)` 的提前返回，每一处都对应一种「差分算不明白了」的情况：

<p class="code-caption"><code>packages/tui/src/tui-main-screen.ts</code> · <code>doRender()</code> 开头</p>

```ts:line-numbers=180
	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines
		let newLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			newLines = this.compositeOverlays(newLines, width, height);
		}

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		newLines = this.applyLineResets(newLines);
```

退化条件包括：终端尺寸变了、上一帧记录是空的、删除的行数超过一屏高度、删除后视口需要上移。这些情况下光标定位的推算会失效，直接清屏重画更可靠。

顺序上有两个细节：

**overlay 在差分之前合成。** 弹窗、对话框不是单独一层，而是被**合并进行数组**再参与比较。于是弹窗的出现和消失也只是「某几行变了」，走同一套差分路径——不需要为浮层维护另一套渲染逻辑。

**光标位置在 `applyLineResets` 之前提取。** 聚焦的组件在自己的输出里埋一个 `CURSOR_MARKER`，TUI 找到它算出硬件光标该放哪，然后才做行级处理。硬件光标位置是单独维护的：**它不属于「内容」，所以内容没变时也可能需要移动它**（第 324 行那个分支专门处理这种情况）。

## 7. 两种屏幕模式

pi-tui 有两个渲染实现：

| | `tui-main-screen.ts`（586 行） | `tui-alt-screen.ts`（890 行） |
|---|---|---|
| 用途 | 常规交互，内容进滚动历史 | 全屏应用（编辑器、游戏、overlay） |
| 关键约束 | 不能破坏用户的 scrollback | 独占一屏，退出后恢复原样 |
| 复杂度来源 | 光标在滚动缓冲区里的绝对位置推算 | 视口管理、滚动 |

主屏模式的难点全在**「不能弄坏用户往上翻的历史」**——你写下去的行会永久留在 scrollback 里，所以重画的范围必须精确，`previousViewportTop`、`hardwareCursorRow`、`computeLineDiff` 这一套都是在算「相对于滚动缓冲区，我现在在第几行」。

备用屏没有这个负担（退出时整屏丢弃），但要自己管视口和滚动，所以反而更长。

## 五条不变式

1. **组件只产出行，不知道自己在哪。** 位置和布局是父容器的事。
2. **一帧内的多次请求合并成一次渲染。** 流式吐字每个 token 都请求，但只出 60fps。
3. **差分只找首尾两个变化点，中间连续重画。** 光标移动的成本比多写几行更高。
4. **一帧原子写出。** 同步输出模式 + 单次 write，消除撕裂。
5. **算不明白就全量重画。** 尺寸变化、大量删除、视口上移一律退化，正确性优先于最优。

## 六篇的位置

这篇是唯一一个和 agent 逻辑完全无关的包——`pi-tui` 不知道什么是模型、什么是工具，它只认识 `Component`。

但它和整条链路有一处关键咬合：[事件系统](/pi/events) 那篇里说「UI 监听者的签名是 `void`，从类型上就没法参与背压」。UI 之所以敢被这样约束，正是因为渲染是异步节流的——监听者收到事件时只调 `requestRender()` 立刻返回，真正的重绘在下一个 16ms 窗口里发生。

**同步的通知 + 异步的渲染**，这个组合才让「UI 不阻塞 agent」成立。

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `tui/src/components/editor.ts` | 2351 | 全库最复杂的组件：多行编辑、kill-ring、undo 栈、自动补全 |
| `tui/src/utils.ts` | — | `visibleWidth` / `sliceByColumn`：ANSI 序列下怎么算宽度 |
| `tui/src/components/markdown.ts` | 861 | 在终端里渲染 Markdown |
| `tui/src/terminal-image.ts` | — | Kitty 图片协议，差分渲染里最难处理的一类内容 |
