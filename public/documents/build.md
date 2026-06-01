# 构建指南

> 首先，如果你只是想用，可以在 [Release](https://github.com/Roj234/ai-chat/releases) 中直接下载  
> 我无法保证构建指南是最新版本，如果遇到问题，请查看本项目的 GitHub Action 构建脚本

## 前置要求

- **Node.js 22+** (建议使用 Node 24 LTS)
- 下载 [Unconscious](https://github.com/Roj234/unconscious) 框架（该项目未发布到 npm）
- 下载 [streaming-markdown](https://github.com/Roj234/streaming-markdown) 解析器（该项目未发布到 npm）
- 一个 OpenAI 兼容的 LLM API 端点（本地或远程均可）

## 快速安装
> 首先，你需要准备 monorepo，结构如下
> ```
> root/
> ├── unconscious/
> ├── streaming-markdown/
> └── ai-chat/
> ```

```bash
# 进入项目目录
cd ai-chat

# 安装依赖
npm i
```

## 启动开发服务器

```bash
npm run dev
```

启动后访问 `http://localhost:5173` 即可使用。开发模式下 Vite 会自动挂载可选后端，数据目录为 `./data`。

## 构建生产版本

```bash
# 构建
npm run build

# 或者，分别构建

# 构建客户端
npm run build:client
# 构建服务端
npm run build:server

# 预览构建结果
npm run preview
```

构建产物位于 `dist/` 目录。

## 部署

### 纯前端部署

这是纯前端项目，将 `dist/` 目录部署到任意静态文件服务器即可：

```bash
# Nginx 示例
cp -r dist/* /var/www/html/

# llama-server 示例
llama-server --path ./dist
```

### 使用可选后端

后端提供多用户、数据同步、断线重连、文件系统访问等功能。  
后端需要你把 dist 压缩为 zip 文件才能使用（打开压缩包，需要能见到 index.html）

```bash
# 进入后端目录安装依赖
cd backend
npm i

# 启动后端
node backend/server.js -p <端口> --data <数据目录> --static dist.zip
```

#### 命令行参数

| 参数 | 说明                              |
|------|---------------------------------|
| `-p <port>` | 监听端口                            |
| `--data <path>` | 数据存储目录                          |
| `--static dist.zip` | 将前端打包在 ZIP 中，由后端统一提供服务          |
| `--workspace <path>` | 启用独立 Agent 模式（禁用数据库服务），限制文件访问范围 |
| `--cert <path>` | 启用 HTTPS（需提供证书路径）               |

### 开发后端

使用 `npm run dev` 时，Vite 自动启动后端（`backend/server-dev.js`）并挂载到开发服务器。  
首次启动时，若 `backend/config.js` 不存在，会自动从 `backend/config.example.js` 复制。

## 构建选项

`vite.config.js` 中可配置构建时变量：

| 变量 | 说明 | 可选值 |
|------|------|--------|
| `DB_MODE` | 数据库模式 | `local` / `remote` / `mixed` |
| `DB_SERVER` | 默认 API 服务器地址 | URL 字符串 |
| `DEFAULT_LLM_ENDPOINT` | 默认 LLM 端点 | URL 字符串 |

## CORS 问题

由于浏览器安全策略，直接请求 LLM API 可能遇到跨域问题。解决方案：

1. **后端代理**：使用可选后端的 SSE 代理功能，自动处理 CORS
2. **反向代理**：在 LLM 服务前部署 Nginx/Caddy 添加 CORS 头
3. **llama-server**：自带 `--path` 参数可直接部署前端，无跨域问题

## 真正的即点即用版本

项目不支持 `file://` 协议（ESM 按需导入需要 HTTP）。  
你可以使用 `vite-single-file` 插件自行构建单文件版本。  
我不建议你这么做，言尽于此。