## 项目简介

**Aint** 是一个纯 Web 的多用途 AI 前端：Chat / Agent / 角色扮演（RP）等多功能合一的单体应用。

- 前端只需要浏览器（Chrome 118+，Firefox 支持有限），无需 Docker、编译或 node_modules 即可使用。
- 后端可选（Node）：数据库、文件服务、命令执行、WebSocket 多端同步、API 代理等；不启用后端时使用 IndexedDB + OPFS + 浏览器内 JS 沙箱。
- 构建工具是 `@roj234/ie`（类 Vite，读取 `vite.config.js` / `vite.app.config.js`）。
- UI 基于 `unconscious`（无 VDOM 响应式框架，JSX + `$state` 等原语）。
- 纯 ESM，`.js` 使用 JSDoc 提供类型；新增独立组件优先 TypeScript。

## 目录结构

```
src/               前端主应用
  components/      UI 组件（JSX + 同名 css，含 MDI 窗口 Windows.jsx、消息列表、工具卡等）
  database/        IndexedDB / 远程数据库 / 同步客户端实现
  markdown/        流式 Markdown 渲染、语法高亮、KaTeX、代码块渲染器
  utils/           通用工具（EventBus、BranchManager、占位符、序列化、唤醒锁…）
  doc_viewer/      文档查看页（docs.html，章节表在 documents.js）
  log_viewer/      请求日志页（log_viewer.html）
  markdown_editor/ Markdown 实时打印页（markdown.html）
  json_editor/     JSON 编辑弹窗
  main.js          主入口
  states.js        全局响应式状态中心 + EVENT_BUS
  settings.js      GLOBAL_SETTINGS 与默认系统/标题提示词
  database.js      数据库抽象层（按 DB_MODE 选择本地/远程）
  toolset.js       工具注册/执行、MCP、工具提示词与上下文构建
  api-request.js   LLM 请求循环、流式 UI 状态、工具调用循环
  commands.js      `/` 斜杠指令注册表
  presets.js       预设与模型列表
  data-exchange.js 对话导入/导出/复制
  conversation-lock.js 会话并发锁
  anti-slop-sampler.js AntiSlop 采样器
  hooks.js         UI 依赖注入挂载点（DI）
  customControls.js 输入框快捷控件
  UserOnboard.js   新手引导（driver.js）
common/            前后端共享：ACL、MCPClient、ReactiveJSON、fetch/fs/glob、压缩 schema、CSS 引擎…
media/             音效合成、供应商预设、默认提示词与介绍图
plugins/           前端插件（按需 import）
  PluginRegistry.js  插件加载顺序、window.AiChatAPI、命令注册
  agent/             文件系统（VFS/Mounts/OverlayFS/VCS）、文件与 Shell 工具、技能、RunJS 沙箱、AGENTS.md 注入
  managers/          Blob 管理器、工具管理器
  fileManager/       文件浏览器 / 预览 / 终端
  context_mgmt/      上下文压缩（主动 / 被动）
  rp_basic/          角色扮演基础（角色卡 / 世界书 / 预设）
  rp_kit/            交互式模拟（骰子、变量、QTE、Wait、AskUser）
  actime/            会话耗时统计（ACTime）
  rpg/               实验性 JSON Schema 游戏框架（已弃用，仅保留示例）
  tools/             预装工具：图表、记忆、JSON 编辑、任务列表、子智能体、生图、上下文占用、追问
  chatbot/           微信机器人
  voiceInput/        录音
  search.js          消息搜索
  thinking_slider/   思考强度滑条
  其余根级插件：DM、PresetFastSwitch、remoteControl、configSync、llamaCpp、mermaid、customBackground、session-cache 等
backend/           可选 Node 后端
  server.js        入口，解析 CLI 参数（-p / --data / --workspace / --static / -c …）
  server-dev.js    开发期把 /api 请求转给 Router 的中间件
  init.js          路由与数据库装配
  router.js        自研路由
  routes/          messages / kv / database / blob-storage / log / search / vectordb / pairing / terminal / agent
  api-proxy/       OpenAI / Responses 兼容代理、限流、断点续传
  plugins/         后端插件（characterViewer、codeGraph、eventDriver、weather、MCP 示例）自动加载
  rag/             向量数据库与本地 embedding 实现
  utils/           UserManager、PAT、压缩、MCP Server、日志钩子等
  config.default.js 配置模板
  types.d.ts       AiChatBackend.* 类型
public/
  assets/          构建产物（sandbox 模块等；sandbox/ 已 gitignore）
  documents/       内置文档，docs.html 读取
  files/           内置技能与记忆模板（运行时复制到 ~/.skills 与 ~/memory）
misc/              launch.sh/bat、安卓配置、Chrome 扩展、PWA 配置、hljs 裁剪脚本
vendor/            构建期处理的静态资源（normalize、remixicon、jsBridge、hljs、chartjs）
test/              浏览器端测试（test.html 手动运行）
```

类型定义：`src/aichat.d.ts`（`AiChat.*`）、`src/openai.d.ts`（`OpenAI.*`）、`backend/types.d.ts`（`AiChatBackend.*`）是全局环境类型，新增数据结构时同步更新。

## 开发与构建命令

```bash
npm run dev          # ie dev：前端开发服务器（默认 5173）+ /api 中间件，数据目录 ./data
npm run build        # ie build && node build_server.js → dist/、dist/server.js、dist.zip、dist.brip
npm run build:client # 仅前端（ie build）
npm run build:server # 仅后端打包为 dist/server.js
npm run build:app    # 安卓版 → dist-app/（IS_ANDROID_BUILD=true）
npm run preview      # 预览构建产物
```

- `postinstall` 会运行 `misc/prune-hljs.mjs` 裁剪 highlight.js。
- 后端配置往 `backend/config.default.js` 加，之后覆盖 `backend/config.js`。

### 构建期注入的全局常量（`define`）

`APP_NAME`、`APP_VERSION`、`DB_MODE`、`IS_ANDROID_BUILD`、`BUILD_NUMBER`，源码里直接当全局变量使用。
`DB_MODE` 源码支持 `local` / `remote` / `mixed`，默认注入 `mixed`。

顶层页面入口（`rollupOptions.input`）：

- `vite.config.js`：`index.html`、`log_viewer.html`、`docs.html`、`markdown.html`、`sw.js`
- `vite.app.config.js`：`index.html`、`log_viewer.html`、`docs.html`、`sw.js`（无 `markdown.html`）

新增顶层页面时，两个配置都要登记（安卓版不需要的除外）。

## 代码风格与约定

- 纯 ESM；`.js` 通过 **JSDoc 注释**提供类型（`@type`、`@param`、`@returns`）。
- 新的独立组件优先用 TypeScript（构建时 Babel 转译）。
- 前端 UI 使用 unconscious 的 JSX 与响应式原语：`$state` / `$computed` / `$derived` / `$watch` / `$store` / `$asyncState` / `unconscious(...)`。
- 跨目录导入使用根路径别名（`/src/...`、`/plugins/...`、`/common/...`、`/vendor/...`）；同目录可用 `./`。避免 `../../`。
- 文件一律 LF/UTF8；`*.bat` / `*.cmd` / `*.ps1` 使用 CRLF/GBK

## 常见改动入口

| 想改什么 | 去哪 |
|----------|------|
| 系统提示词 / 设置项 | `src/settings.js`（`GLOBAL_SETTINGS`、`defaultSystemPrompt`） |
| `/` 指令 | `src/commands.js` 的 `COMMAND_REGISTRY` |
| 前端工具 | 调用 `registerToolset(name, description, toolDefs, options)`（`src/toolset.js`） |
| 技能系统 / AGENTS.md 注入 | `plugins/agent/skills.js`、`plugins/agent/agents-md.js` |
| 前端插件 | 在 `plugins/<name>/` 新建，并在 `plugins/PluginRegistry.js` import；可用 `window.AiChatAPI` |
| 后端 API | `backend/init.js` 装配 + `backend/routes/*.js` |
| 后端插件 | `backend/plugins/<name>/index.js`，default export 接收 `(router, workspace)`，自动加载 |
| 数据库 / 同步 | `src/database.js`、`src/database/*`、`backend/sync*.js` |

其他约定：

- 前端工具注册后由 `runTools` 统一执行；每个工具定义必须提供 `script(parameters, msg, conv, ...)`，可配合 `parallel`、`interactive` 等字段。注意工具的审批级别与 `activatedModules`。
- 前端沙箱模块由 `common/build-sandbox-modules.js` 在构建时用 esbuild 处理；新增模块需加入 `SANDBOX_MODULES`。
- 安卓构建使用 `vendor/jsBridge.js` 提供的原生桥。
- MDI 多窗口用 `src/components/Windows.jsx`，不要自己写弹窗层。

## 测试与验证

- **前端没有 headless 测试**：`test/index.js` 是浏览器测试运行器，用 `npm run dev` 打开 `test.html` 点“开始测试”。
- 新增用例写在 `test/` 下，并 `import` 进 `test/tests.js`。
- 改动构建相关代码后至少跑一次 `npm run build`；涉及后端时在 `dist/` 下用 `node server.js --static dist.brip` 起服务验证。

## 文档

| 文档 | 内容 |
|------|------|
| [使用指南](public/documents/usage.md) | 命令、界面、设置、多模态输入 |
| [构建与部署](public/documents/build.md) | 开发、生产构建、CORS 解决方案 |
| [Agent 与文件系统](public/documents/agent-filesystem.md) | 完全编辑模式、文件访问、安全建议 |
| [高级功能](public/documents/advanced-features.md) | AntiSlop、对话分支、角色扮演基础、思考模式 |
| [RPG 管线](public/documents/rpg-pipeline.md) | 约束采样、流式 JSON 解析 |
| [插件开发](public/documents/plugin-development.md) | 工具注册、命令、后端插件 |
| [API 参考](public/documents/api-reference.md) | LLM 中转站、批量请求、WebSocket 同步 |
| [ReactiveJSON](public/documents/ReactiveJSON.md) | 响应式 JSON 开发指南 |
| [设计哲学](public/documents/philosophy.md) | 设计理念 |
| [路线图](public/documents/roadmap.md) | 已知问题和计划中的功能 |
| [TTS & 生图](public/documents/tts.md) | 端点配置与 API 规范 |