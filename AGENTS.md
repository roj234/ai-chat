
## 项目简介

**AiChat（爱聊天）** 是一个纯 Web 的多用途 AI 前端：Chat / Agent / 角色扮演（RP）等多功能合一的单体应用。

- 基于作者自研的**无 VDOM 响应式框架 [Unconscious](https://github.com/Roj234/unconscious)**，以及自研流式 Markdown 解析器 [streaming-markdown](https://github.com/Roj234/streaming-markdown)。

## 目录结构

```
src/               前端主应用（入口 src/aichat.js）
  components/      UI 组件（unconscious JSX + 同名 .css）
  database/        数据库后端和同步服务实现：indexedDB.js / remoteDB.js / syncClient.js
  markdown/        流式 Markdown 渲染、语法高亮、代码块渲染
  utils/           前端工具（BranchManager、EventBus、marshal 等）
  states.js        全局响应式状态中心
  database.js      数据库抽象层（本地/远程切换）
  toolset.js       工具注册与激活核心
  settings.js      设置项定义
  api-request.js   LLM 请求与流式处理
common/            前后端共享代码（fs-common、MCPClient、LRUCache、ReactiveJSON…）
plugins/           前端插件与 Agent 工具
  PluginRegistry.js  插件/工具注册总表
  tools/             Agent 工具（agent.js 文件系统、subagent.js、run_js.js…）
  rp_basic/          基础角色扮演插件（角色卡/世界书/预设）
  rpg/               约束采样 RPG 管线与技能 schema
backend/           可选 Node 后端（server.js 入口，无构建依赖）
  routes/          HTTP 路由（agent、sse-proxy、database、vectordb…）
  init.js          路由与数据库装配
  config.example.js  配置模板（复制为 config.js 后生效）
  tsdb/            自研时序数据库（日志）
public/            按需加载资源（sandbox 模块、mermaid、chunks…）
  documents/       用户与开发文档（中文，写新文档放这里）
vendor/            第三方静态资源（normalize、remixicon、Android jsBridge 等）
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

- `npm run build` 产出 `dist/`（前端）、`dist/server.js`（后端单文件）、`dist.zip` / `dist.brip`（含 `public/`、`misc/pwa-config` 的打包）。

### 构建期注入的全局常量（vite `define`）

`APP_NAME`、`APP_VERSION`、`DB_MODE`（`local`/`remote`/`mixed`）、`RESUME_TIMEOUT`、`IS_ANDROID_BUILD`、`BUILD_NUMBER`。
它们在 `vite.config.js` / `vite.app.config.js` 中定义，源码里直接当全局变量使用（不要 `import`）。

新增顶层 HTML 页面时，需要在 `vite.config.js` 的 `rollupOptions.input` 中登记。

## 代码风格

- 纯 ESM；`.js` 通过 **JSDoc 注释**提供类型（`@type`、`@param`、`@returns`）。
- 如果可能（linter happy），新的独立组件应当使用 TypeScript 编写（自动使用 babel 转译为 JavaScript）。
- 前端 UI 使用 unconscious 的 JSX 与响应式原语：`$state` / `$computed` / `$watch` / `$store` / `$asyncState` / `unconscious(...)`。
## 测试与验证

- **前端没有 headless 测试**：`test/index.js` 是浏览器测试运行器，用 `npm run dev` 打开 `test.html` 点“开始测试”。新增用例在 `test/` 下写并 `import` 进 `test/tests.js`。
