---
skills:
  - README.md
---

## 项目简介

**Aint** 是一个纯 Web 的多用途 AI 前端：Chat / Agent / 角色扮演（RP）等多功能合一的单体应用。

## 目录结构

```
src/               前端主应用
  components/      UI 组件（JSX + css）
  database/        数据库后端和同步服务实现
  markdown/        流式 Markdown 渲染和高亮
  utils/           前端工具
  main.js          入口
  states.js        全局响应式状态中心
  database.js      数据库抽象层（本地/远程切换）
  toolset.js       工具注册与激活核心
  settings.js      设置项定义
  api-request.js   LLM 请求循环与流式UI状态维护
common/            共享代码（文件操作抽象、MCP协议、LRUCache、ReactiveJSON…）
media/             程序生成音频、介绍图、预置系统提示词等
plugins/           前端插件
  PluginRegistry.js  插件/工具注总表
  actime/            会话耗时分析插件
  agent/             文件系统抽象，工具、技能系统及实现
  chatbot/           微信机器人插件
  managers/          工具管理器和附件管理器
  rp_basic/          基础角色扮演插件（角色卡/世界书/预设）
  rp_kit/            交互式模拟插件（骰子、变量、QTE、覆盖层）
  rpg/               实验性JSON Schema游戏框架（已弃用）
  tools/             插件化工具（图表、记忆、JSON编辑、任务列表、图像生成、子代理等）
  voiceInput/        录音插件
backend/           可选 Node 后端
  routes/          HTTP 路由（agent、sse-proxy、database、vectordb…）
  init.js          路由与数据库装配
  config.example.js  配置模板
  tsdb/            自研日志数据库
public/
  assets/          预先打包的静态资源（mermaid, pptx-js等）
  documents/       文档
vendor/            在构建时处理的静态资源（normalize、remixicon、Android jsBridge 等）
test/              浏览器端测试（test.html 手动运行）
```

类型定义：`src/aichat.d.ts`（`AiChat.*`）、`src/openai.d.ts`（`OpenAI.*`）、`backend/types.d.ts`（`AiChatBackend.*`）为全局环境类型，新增数据结构时同步更新。

## 开发与构建命令

```bash
npm run dev          # 开发服务器（5173），自动挂载后端，数据目录 ./data
npm run build        # 生产构建：vite build && node build_server.js → dist/
npm run build:client # 仅前端
npm run build:server # 仅后端打包为 dist/server.js
npm run build:app    # 安卓版 → dist-app/
npm run preview      # 预览构建产物
```

- `npm run build` 产出 `dist/`（前端）、`dist/server.js`（后端单文件）、`dist.zip` / `dist.brip`。

### 构建期注入的全局常量（vite `define`）

`APP_NAME`、`APP_VERSION`、`DB_MODE`（`local`/`remote`/`mixed`）、`RESUME_TIMEOUT`、`IS_ANDROID_BUILD`、`BUILD_NUMBER`。
它们在 `vite.config.js` / `vite.app.config.js` 中定义，源码里直接当全局变量使用。

新增顶层 HTML 页面时，需要在 `vite.config.js` 的 `rollupOptions.input` 中登记。

## 代码风格

- 纯 ESM；`.js` 通过 **JSDoc 注释**提供类型（`@type`、`@param`、`@returns`）。
- 如果可能（linter happy），新的独立组件应当使用 TypeScript 编写（自动使用 babel 转译为 JavaScript）。
- 前端 UI 使用 unconscious 的 JSX 与响应式原语：`$state` / `$computed` / `$watch` / `$store` / `$asyncState` / `unconscious(...)`。

## 测试与验证

- **前端没有 headless 测试**：`test/index.js` 是浏览器测试运行器，用 `npm run dev` 打开 `test.html` 点“开始测试”。新增用例在 `test/` 下写并 `import` 进 `test/tests.js`。
