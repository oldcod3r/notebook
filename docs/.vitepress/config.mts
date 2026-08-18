import { defineConfig } from "vitepress";

export default defineConfig({
	title: "notebook",
	description: "源码走读与技术笔记",
	lang: "zh-CN",

	// 项目站点部署在 https://oldcod3r.github.io/notebook/，base 必须与仓库名一致
	base: "/notebook/",

	lastUpdated: true,
	cleanUrls: false,
	ignoreDeadLinks: true,

	head: [["meta", { name: "theme-color", content: "#0f6e77" }]],

	themeConfig: {
		nav: [
			{ text: "首页", link: "/" },
			{ text: "pi", link: "/pi/" },
			{ text: "DeepSeek Harness", link: "/deepseek-harness/" },
			{ text: "GPT-5.6 Agent", link: "/gpt-5-6-agent-paradigm-shift" },
		],

		sidebar: {
			"/deepseek-harness/": [
				{
					text: "DeepSeek Harness",
					items: [
						{ text: "内容索引", link: "/deepseek-harness/" },
						{ text: "Agent Note 决策生命周期", link: "/deepseek-harness/agent-note-lifecycle" },
						{ text: "事件溯源的 Agent 会话", link: "/deepseek-harness/event-sourced-sessions" },
						{ text: "Subagent 多后端抽象", link: "/deepseek-harness/subagent-provider-seam" },
						{ text: "后台 Subagent 任务模型", link: "/deepseek-harness/background-subagent-jobs" },
						{ text: "持久化可继续 Subagent", link: "/deepseek-harness/continuable-subagent-sessions" },
						{ text: "上下文压缩", link: "/deepseek-harness/context-compaction" },
						{ text: "Skill 渐进式披露", link: "/deepseek-harness/progressive-skill-disclosure" },
						{ text: "Agent 沙箱与权限升级", link: "/deepseek-harness/sandbox-and-escalation" },
						{ text: "审批路由", link: "/deepseek-harness/approval-routing" },
						{ text: "工具并行调度", link: "/deepseek-harness/parallel-tool-scheduling" },
						{ text: "协作式工具取消", link: "/deepseek-harness/cooperative-tool-cancellation" },
						{ text: "真实 API E2E", link: "/deepseek-harness/real-api-e2e" },
						{ text: "Agent 工程文档写作", link: "/deepseek-harness/agent-prose-standard" },
						{ text: "推理过程泄漏清理", link: "/deepseek-harness/reasoning-leakage" },
						{ text: "Agent 项目代码审查", link: "/deepseek-harness/agent-code-review" },
					],
				},
			],
			"/pi/": [
				{
					text: "Pi Agent Harness",
					items: [
						{ text: "总览", link: "/pi/" },
						{ text: "pi-ai", link: "/pi/pi-ai" },
						{ text: "agent loop", link: "/pi/agent-loop" },
						{ text: "工具执行", link: "/pi/tools" },
						{ text: "事件系统", link: "/pi/events" },
						{ text: "会话存储", link: "/pi/sessions" },
						{ text: "pi-tui", link: "/pi/tui" },
						{ text: "扩展系统", link: "/pi/extensions" },
					],
				},
			],
		},

		socialLinks: [{ icon: "github", link: "https://github.com/oldcod3r/notebook" }],

		outline: { level: [2, 3], label: "本页目录" },

		search: {
			provider: "local",
			options: {
				translations: {
					button: { buttonText: "搜索", buttonAriaLabel: "搜索" },
					modal: {
						displayDetails: "显示详情",
						resetButtonTitle: "清除",
						backButtonTitle: "返回",
						noResultsText: "没有找到结果",
						footer: { selectText: "选择", navigateText: "切换", closeText: "关闭" },
					},
				},
			},
		},

		docFooter: { prev: "上一篇", next: "下一篇" },
		lastUpdatedText: "最后更新",
		returnToTopLabel: "回到顶部",
		sidebarMenuLabel: "目录",
		darkModeSwitchLabel: "主题",
		lightModeSwitchTitle: "切换到浅色模式",
		darkModeSwitchTitle: "切换到深色模式",

		footer: {
			message: "笔记内容基于各开源项目源码整理",
			copyright: "© oldcod3r",
		},
	},

	markdown: {
		// 行号按需在代码块上用 :line-numbers=<起始行> 开启，
		// 这样渲染出的行号能和上游仓库的真实行号对齐
		lineNumbers: false,
	},
});
