---
title: Pi Agent Harness
description: earendil-works/pi 源码走读系列总览
---

# Pi Agent Harness

[earendil-works/pi](https://github.com/earendil-works/pi) 是一个 TypeScript 编写的 agent 框架，包含一个可自扩展的编码 agent CLI。这个系列拆解它的核心实现。

::: tip 走读基准
所有笔记基于 commit `588915ec7`，文中行号与该版本的仓库一致。
:::

## 分层结构

```text
pi-ai            ← 多厂商 LLM 统一 API（不知道什么叫 agent）
   ↑
pi-agent-core    ← agent 循环 + 工具执行 + 事件（不碰 IO、不碰 UI）
   ↑
pi-coding-agent  ← 真正的 CLI：工具、会话、扩展、上下文压缩、交互模式
   ↑                    ↖ pi-tui（终端差分渲染，独立库）
protocol / client / server ← 把会话通过 CBOR 帧协议暴露出去（RPC 模式）
```

关键在于**下层完全不知道上层的存在**：`agent` 包不碰文件系统、不碰终端；`ai` 包不知道什么叫 agent。这个约束是它能被拆成独立 npm 包复用的原因。

## 包一览

| 包 | 职责 | 关键文件 |
|---|---|---|
| `@earendil-works/pi-ai` | 70+ 厂商、约 10 种 wire protocol 的统一抽象 | `models.ts`、`api/*.ts`、`providers/*.ts` |
| `@earendil-works/pi-agent-core` | agent 循环、工具执行、事件与队列 | `agent-loop.ts`、`agent.ts`、`types.ts` |
| `@earendil-works/pi-coding-agent` | CLI 本体：7 个内置工具、会话树、扩展系统 | `core/agent-session.ts`、`core/tools/`、`core/extensions/` |
| `@earendil-works/pi-tui` | 终端 UI，差分渲染，无虚拟 DOM | `tui.ts`、`components/editor.ts` |

## 已有笔记

按**运行时链路**排列，建议顺序读——每一篇都会用到前一篇建立的概念。

1. [**pi-ai**](/pi/pi-ai) —— 46 个 provider 与 10 种协议如何解耦：加一家厂商 15 行、加一种协议一千行；24 条正则只为判断「上下文超了」。**它产生事件流。**
2. [**agent loop**](/pi/agent-loop) —— 整个项目最该读的 792 行：双层循环、工具调度的两种顺序、那些踩过坑才会写出来的防御。**它消费事件流并驱动循环。**
3. [**工具执行**](/pi/tools) —— 七个内置工具的三个共同设计：可替换的执行后端、截断即引导、按文件 realpath 排队。**它是被循环调度的那一端。**
4. [**事件系统**](/pi/events) —— 一条事件从循环发出后，如何依次经过队列同步、扩展、UI 和会话文件。**它是循环输出的去向。**
5. [**会话存储**](/pi/sessions) —— append-only 的 JSONL 树：分支只是移动一个指针，压缩不删除任何东西。**事件落盘后的形态。**
6. [**pi-tui**](/pi/tui) —— 一个方法的组件契约、60fps 节流、只找首尾两个变化点的差分渲染。**事件最终怎么显示出来。**
7. [**扩展系统**](/pi/extensions) —— 「self extensible」的实际重量：一个工厂函数、33 个事件、四种分发策略，以及唯一一处故意不 catch 的地方。**它横切以上全部环节。**

## 待写

主干七篇已覆盖 `pi-ai`、`agent-core`、`coding-agent`、`pi-tui` 四个包。剩下可写的：

- `protocol` / `client` / `server`：把会话通过 CBOR 帧协议暴露出去的 RPC 模式
- `agent/src/harness/`：agent 包里那套更抽象的会话与技能实现
