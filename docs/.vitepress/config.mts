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
		],

		sidebar: {
			"/pi/": [
				{
					text: "pi agent harness",
					items: [
						{ text: "总览", link: "/pi/" },
						{ text: "agent loop 源码走读", link: "/pi/agent-loop" },
						{ text: "pi-ai 源码走读", link: "/pi/pi-ai" },
						{ text: "工具执行源码走读", link: "/pi/tools" },
						{ text: "事件系统源码走读", link: "/pi/events" },
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
