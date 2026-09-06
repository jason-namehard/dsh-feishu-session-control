import { defineConfig } from 'vitepress';

export default defineConfig({
  srcDir: 'docs',
  lang: 'zh-CN',
  title: 'DSH飞书Session控制',
  description: '把 DeepSeek Harness (dsh) 装进飞书 / Lark 的开源桥接插件：扫码即用，流式卡片、并行任务、多角色 Agent、跨会话通知、通知转发到其他 IM 与安全网守护。',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/favicon.svg' }],
    ['meta', { name: 'author', content: '见川' }],
    ['meta', { name: 'keywords', content: 'deepseek harness 连接飞书,deepseek harness 飞书,deepseek 飞书机器人,deepseek harness 扫码,dsh 飞书,dsh-lark-bot,飞书 接入 deepseek,deepseek harness 插件,telegram 通知,企业微信 webhook' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'DSH飞书Session控制' }],
    ['meta', { property: 'og:title', content: 'DSH飞书Session控制：把 DeepSeek Harness 装进飞书 / Lark' }],
    ['meta', { property: 'og:description', content: '扫码把 DeepSeek Harness 装进飞书：流式卡片、并行任务、多角色 Agent、跨会话通知、通知转发到其他 IM、安全网守护。' }],
    ['meta', { name: 'twitter:card', content: 'summary' }],
  ],
  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'DSH飞书Session控制',
    outline: { level: [2, 3], label: '本页目录' },
    nav: [
      { text: '首页', link: '/' },
      { text: '使用文档', link: '/guide/quickstart', activeMatch: '/guide/' },
      { text: '通知转发到其他 IM', link: '/guide/notification-sinks', activeMatch: '/guide/notification-sinks' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: '使用指南',
          items: [
            { text: '快速开始', link: '/guide/quickstart' },
            { text: '核心功能', link: '/guide/features' },
            { text: '命令速览', link: '/guide/commands' },
            { text: '通知转发到其他 IM', link: '/guide/notification-sinks' },
            { text: '配置', link: '/guide/configuration' },
            { text: '安全与权限', link: '/guide/security' },
            { text: '排障与 FAQ', link: '/guide/troubleshooting' },
          ],
        },
      ],
    },
    search: {
      provider: 'local',
      options: {
        translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' } },
      },
    },
    socialLinks: [],
    darkModeSwitchLabel: '外观',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    footer: {
      message: 'AGPL-3.0 · 开源可自托管 · 个人 / 内部使用免费',
      copyright: '© 2026 见川 · npm/DSH 兼容包名：dsh-lark-bot / dsh-feishu-bot',
    },
  },
});
