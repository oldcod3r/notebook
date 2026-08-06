---
title: pi agent harness
description: earendil-works/pi 源码走读系列总览
---

# pi agent harness

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

- [**agent loop 源码走读**](/pi/agent-loop) —— 整个项目最该读的 792 行：双层循环、工具调度的两种顺序、以及那些踩过坑才会写出来的防御。
- [**pi-ai 源码走读**](/pi/pi-ai) —— 46 个 provider 与 10 种协议如何解耦：加一家厂商 15 行、加一种协议一千行；以及 24 条正则只为判断「上下文超了」。
- [**工具执行源码走读**](/pi/tools) —— 七个内置工具的三个共同设计：可替换的执行后端、截断即引导、按文件 realpath 排队。
- [**事件系统源码走读**](/pi/events) —— 一条事件从循环发出后，如何依次经过队列同步、扩展、UI 和会话文件，以及为什么是这个顺序。
- [**扩展系统源码走读**](/pi/extensions) —— 「self extensible」的实际重量：一个工厂函数、33 个事件、四种分发策略，以及唯一一处故意不 catch 的地方。
- [**会话存储源码走读**](/pi/sessions) —— append-only 的 JSONL 树：分支只是移动一个指针，压缩不删除任何东西。
- [**pi-tui 源码走读**](/pi/tui) —— 一个方法的组件契约、60fps 节流，以及只找首尾两个变化点的差分渲染。

前五篇是同一条链路的不同切面：`pi-ai` 产生事件流 → `agent loop` 驱动循环并调度工具 → `工具执行` 是被调度的那一端 → `事件系统` 是循环输出的去向 → `扩展系统` 是在以上每个环节插手的能力。后两篇是两个独立的支撑层：`会话存储` 管事件落盘之后的形态，`pi-tui` 管它怎么显示出来。建议按顺序读。

## 待写

主干七篇已覆盖 `pi-ai`、`agent-core`、`coding-agent`、`pi-tui` 四个包。剩下可写的：

- `protocol` / `client` / `server`：把会话通过 CBOR 帧协议暴露出去的 RPC 模式
- `agent/src/harness/`：agent 包里那套更抽象的会话与技能实现
- 会话的 append-only JSONL 树：分支、压缩、从任意历史点分叉
- `pi-tui` 的差分渲染：`render(width): string[]` 这个极简契约能走多远
