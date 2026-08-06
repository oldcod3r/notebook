# notebook

源码走读与技术笔记，用 [VitePress](https://vitepress.dev) 构建，通过 GitHub Actions 部署到 GitHub Pages。

**站点地址**：https://oldcod3r.github.io/notebook/

## 内容

`pi` 系列按运行时链路排列：

| # | 篇目 | 一句话 |
|---|---|---|
| 1 | [pi-ai](https://oldcod3r.github.io/notebook/pi/pi-ai) | 多厂商 LLM 统一层，46 个 provider × 10 种协议如何解耦 |
| 2 | [agent loop](https://oldcod3r.github.io/notebook/pi/agent-loop) | agent 循环本体，792 行逐段拆解 |
| 3 | [工具执行](https://oldcod3r.github.io/notebook/pi/tools) | 七个内置工具：可替换后端、截断策略、并发写入 |
| 4 | [事件系统](https://oldcod3r.github.io/notebook/pi/events) | 事件的三层扇出与背压边界 |
| 5 | [会话存储](https://oldcod3r.github.io/notebook/pi/sessions) | append-only 的 JSONL 树，分支即移动指针 |
| 6 | [pi-tui](https://oldcod3r.github.io/notebook/pi/tui) | 一个方法的组件契约与差分渲染 |
| 7 | [扩展系统](https://oldcod3r.github.io/notebook/pi/extensions) | 一个函数撑起的自扩展能力，四种分发策略 |

## 本地开发

```bash
npm install
npm run docs:dev      # 开发服务器，http://localhost:5173/notebook/
npm run docs:build    # 构建到 docs/.vitepress/dist
npm run docs:preview  # 预览构建产物，http://localhost:4173/notebook/
```

## 目录结构

```
docs/
├─ .vitepress/
│  ├─ config.mts        站点配置（导航、侧边栏、本地搜索）
│  └─ theme/            自定义样式（代码块来源标注等）
├─ index.md             首页
└─ pi/
   ├─ index.md          分组总览
   └─ agent-loop.md     正文
```

## 写作约定

- 代码块用 ` ```ts:line-numbers=<起始行> ` 声明起始行号，**渲染出的行号与上游仓库的真实行号一致**，读者可以直接对着源码跳转。
- 每篇开头标注走读所基于的 commit，代码演进后仍能对上号。
- 代码块上方用 `<p class="code-caption">` 标注来源函数与文件。

## 部署

推送到 `main` 触发 `.github/workflows/deploy.yml`，构建后由 `actions/deploy-pages` 发布。

首次部署前需要在仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**（不是 Deploy from a branch），否则工作流会在部署步骤失败。
