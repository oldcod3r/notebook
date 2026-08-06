---
title: 会话存储源码走读
description: append-only 的 JSONL 树：分支只是移动一个指针，压缩不删除任何东西
---

# 会话存储源码走读

::: info 走读基准
[earendil-works/pi](https://github.com/earendil-works/pi) @ commit `588915ec7`，文件 `packages/coding-agent/src/core/session-manager.ts`，共 1714 行。**代码块左侧行号与仓库真实行号一致**。
:::

大多数聊天应用把会话存成一个数组：消息追加在后面，编辑就改一条，重来就清空。pi 存成**一棵只增不改的树**——每条记录带 `id` 和 `parentId`，从任意一点分叉出新分支，旧的那条路原封不动留着。

这个选择带来的能力：从历史任意一点重跑、编辑早先的提问而不丢失后续、上下文压缩后还能翻出被压缩掉的原文。代价是「当前对话是什么」不再是一个数组，而是**一次从叶子到根的回溯**。

## 1. 每条记录都知道自己的父亲

<p class="code-caption"><code>core/session-manager.ts</code></p>

```ts:line-numbers=46
export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}
```

四个字段，整棵树的全部结构。`parentId` 为 `null` 就是根。

在这个基础上派生出九种条目：

| 类型 | 装什么 | 进不进模型上下文 |
|---|---|---|
| `message` | 用户/助手/工具结果消息 | ✅ |
| `custom_message` | 扩展注入的内容 | ✅ 转成 user 消息 |
| `custom` | 扩展自己的状态 | ❌ 纯持久化 |
| `compaction` | 压缩摘要 + 保留起点 | ✅ 摘要参与 |
| `branch_summary` | 被放弃分支的摘要 | ✅ |
| `model_change` | 切了模型 | ❌ 但影响设置 |
| `thinking_level_change` | 切了思考等级 | ❌ 但影响设置 |
| `label` | 书签 | ❌ |
| `session_info` | 会话显示名 | ❌ |

::: tip 两种「自定义」的分工
`CustomEntry` 和 `CustomMessageEntry` 长得很像，区别只有一条：**前者不参与 LLM 上下文，后者参与**。

扩展要存自己的状态（比如「我给哪些文件做过索引」）用前者——重载会话时扫一遍自己的 `customType` 就能恢复；要往对话里塞内容（比如注入一段项目规范）用后者。
:::

## 2. 追加：三行，外加一个指针

<p class="code-caption"><code>core/session-manager.ts</code> · <code>_appendEntry()</code></p>

```ts:line-numbers=1044
	private _appendEntry(entry: SessionEntry): void {
		this.fileEntries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		this._persist(entry);
	}
```

内存里两份：一个**顺序数组**（写文件用）、一个 **id 索引**（回溯用）。然后把 `leafId` 移到新条目上。

`leafId` 是整个设计的枢纽——它指向「当前对话的末端」。所有 `appendXxx()` 都以它作为新条目的 `parentId`，然后自己成为新的 `leafId`。

## 3. 分支：就是移动那个指针

<p class="code-caption"><code>core/session-manager.ts</code> · <code>branch()</code></p>

```ts:line-numbers=1354
	/**
	 * Start a new branch from an earlier entry.
	 * Moves the leaf pointer to the specified entry. The next appendXXX() call
	 * will create a child of that entry, forming a new branch. Existing entries
	 * are not modified or deleted.
	 */
	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leafId = branchFromId;
	}
```

**函数体除了校验只有一行。**

这就是 append-only 树的红利：「从第 5 条消息重新开始」不需要删除第 6 条之后的任何东西，也不需要复制前 5 条。把 `leafId` 指回第 5 条，下一次 append 就自然成了它的第二个孩子。两条分支并存在同一个文件里，靠 `parentId` 区分。

注释里那句 `Existing entries are not modified or deleted` 是这个数据结构的核心承诺。**没有任何操作会改写已写入的行**——这也是它能安全地边写边用 `appendFileSync` 的原因。

配套的 `resetLeaf()` 把指针置为 `null`，下一条就成了新的根——用于重新编辑第一句话。

## 4. 惰性落盘：没等到助手回复就不建文件

<p class="code-caption"><code>core/session-manager.ts</code> · <code>_persist()</code></p>

```ts:line-numbers=1015
	_persist(entry: SessionEntry): void {
		if (!this.persist || !this.sessionFile) return;

		const hasAssistant = this.fileEntries.some((e) => e.type === "message" && e.message.role === "assistant");
		if (!hasAssistant) {
			if (this.flushed) {
				appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
			} else {
				// Mark as not flushed so when assistant arrives, all entries get written
				this.flushed = false;
			}
			return;
		}

		if (!this.flushed) {
			const fd = openSync(this.sessionFile, "wx");
			try {
				for (const e of this.fileEntries) {
					writeFileSync(fd, `${JSON.stringify(e)}\n`);
				}
			} finally {
				closeSync(fd);
			}
			this.flushed = true;
		} else {
			appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
		}
	}
```

**第一条助手消息到达之前，什么都不写盘。**

理由很实际：用户启动 pi、看了一眼、Ctrl-C 退出——这种「空会话」如果也落盘，会话列表里会堆满只有一行的垃圾文件。等到模型真的回复了，才认为「这是一次真实的会话」，把之前攒的条目一次性补写。

注意 `openSync(this.sessionFile, "wx")` 的 `wx` 标志：**文件已存在就报错**。这是防重复创建的保险——补写只应该发生一次。之后 `flushed = true`，后续条目走 `appendFileSync` 逐行追加。

## 5. 当前对话 = 从叶子回溯到根

<p class="code-caption"><code>core/session-manager.ts</code> · <code>buildSessionPath()</code></p>

```ts:line-numbers=334
function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}
```

从 `leafId` 出发，顺着 `parentId` 一路爬到根，然后 `reverse()`。

三个默认行为值得注意：

- `leafId === null` → 返回**空数组**。这是「重置到起点」的显式状态，和「没传 leafId」不同。
- `leafId` 传了但找不到 → 退回到 `entries[entries.length - 1]`，即文件里最后写入的那条。容错，不抛异常。
- 完全没传 → 同样用最后一条。这是加载一个会话文件后的默认行为：**最后写入的分支就是当前分支**。

时间复杂度是路径长度而不是文件总条数——一个有几十条废弃分支的大会话，走当前路径依然很快。

## 6. 设置也是沿着路径生效的

<p class="code-caption"><code>core/session-manager.ts</code> · <code>getSessionContextSettings()</code></p>

```ts:line-numbers=362
function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}
```

模型和思考等级不是会话的全局属性，而是**沿路径重放出来的**。顺着当前路径走一遍，后面的覆盖前面的，走完就是当前状态。

于是分支天然携带自己的设置：在 A 分支切到 Opus、在 B 分支切到 Haiku，两条路径各自回溯出各自的模型。不需要额外记录「这个分支用什么模型」。

最后那条 `else if` 是个巧妙的兜底：**一条助手消息本身就记录了它是哪个模型产生的**。所以哪怕没有显式的 `model_change` 条目（比如从别处导入的会话），也能从消息里推断出当前模型。

## 7. 压缩不删除任何东西

<p class="code-caption"><code>core/session-manager.ts</code> · <code>buildContextEntries()</code></p>

```ts:line-numbers=410
/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}
```

上下文压缩在很多实现里是破坏性的：把老消息换成摘要，原文就没了。这里不是。

压缩产生的只是路径上的一条 `compaction` 条目，带两个关键字段：`summary`（摘要文本）和 `firstKeptEntryId`（从哪条开始保留原文）。**被"压缩掉"的条目仍然在文件里、仍然在树上**，只是构造模型上下文时被跳过。

组装顺序是：

```text
[compaction 摘要]  +  [firstKeptEntryId .. 压缩点之间的原文]  +  [压缩点之后的新对话]
```

摘要被放在**最前面**——它代表的是更早的历史，位置上就该在保留原文之前。

`let compaction` 那个循环取的是路径上**最后一个**压缩条目：一次长会话可能压缩多次，只有最近那次有效，更早的压缩条目本身也在被跳过的区间里。

::: tip 这条路径带来的实际能力
因为原文没丢，UI 上可以展开被压缩的部分让用户查看；出了问题可以从压缩点之前分支重来；甚至可以换个策略重新压缩一次。

**「模型看到什么」和「会话记录了什么」是两件事**——这和 [agent loop](/pi/agent-loop) 里 `AgentMessage` 只在发请求那一刻才降格成 `Message` 是同一个思路，在存储层的又一次体现。
:::

## 五条不变式

1. **已写入的行永不修改。** 所有操作都是追加，这是 `appendFileSync` 敢边写边用的前提。
2. **`leafId` 是唯一的可变状态。** 分支、重置、切换历史点，改的都只是这一个指针。
3. **「当前对话」是算出来的，不是存着的。** 每次从叶子回溯，路径长度就是成本。
4. **设置沿路径重放。** 分支天然携带自己的模型和思考等级，无需额外记录。
5. **压缩是视图层的省略，不是数据层的删除。**

## 和其它几篇的接缝

| 接缝 | 会话层 | 别处 |
|---|---|---|
| **什么时候写** | `message_end` 触发 `appendMessage` | [事件系统](/pi/events) 的第四步扇出 |
| **写什么** | `AgentMessage` 原样存，含 UI-only 类型 | [agent loop](/pi/agent-loop) 的 `convertToLlm` 只在发请求时过滤 |
| **压缩谁触发** | `compaction` 条目由外部写入 | [agent loop](/pi/agent-loop) 的 `prepareNextTurn` 换上压缩后的上下文 |
| **扩展的状态** | `CustomEntry` 持久化 | [扩展系统](/pi/extensions) 重载后扫自己的 `customType` 恢复 |

## 配套阅读

| 文件 | 行数 | 为什么值得读 |
|---|---|---|
| `core/compaction/compaction.ts` | — | 压缩点怎么选、摘要怎么生成 |
| `core/compaction/branch-summarization.ts` | — | 放弃一条分支时如何提炼它的上下文 |
| `agent/src/harness/session/` | — | agent 包里另一套更抽象的会话实现 |
