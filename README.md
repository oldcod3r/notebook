# notebook

源码走读与技术笔记，用 [VitePress](https://vitepress.dev) 构建，通过 GitHub Actions 部署到 GitHub Pages。

**站点地址**：https://oldcod3r.github.io/notebook/

## 内容

| 分组 | 篇目 |
|---|---|
| [pi](https://oldcod3r.github.io/notebook/pi/) | [agent loop 逐段精读](https://oldcod3r.github.io/notebook/pi/agent-loop) —— `earendil-works/pi` 的 agent 循环，792 行逐段拆解 |

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
