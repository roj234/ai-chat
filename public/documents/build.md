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

见 README。

#### 命令行参数

| 参数 | 说明                       |
|------|--------------------------|
| `-p <port>` | 监听端口                     |
| `--data <path>` | 数据存储目录                   |
| `--static dist.zip` | 加载打包在 ZIP 中的前端，并提供静态文件服务 |
| `--workspace <path>` | 专用文件服务（禁用数据库服务）          |
| `--cert <path>` | 启用 HTTPS（需提供证书路径）        |

- 只有专用文件服务，才能执行命令。
- 设计用途：用户在沙盒中运行专用文件服务，并暴露 HTTP 端口。

### 开发后端

使用 `npm run dev` 时，Vite 自动启动后端（`backend/server-dev.js`）并挂载到开发服务器。  
首次启动时，若 `backend/config.js` 不存在，会自动从 `backend/config.example.js` 复制。

## 构建选项

`vite.config.js` 中可配置构建时变量：

| 变量 | 说明 | 可选值 |
|------|------|--------|
| `DB_MODE` | 数据库模式 | `local` / `remote` / `mixed` |
| `DB_SERVER` | 默认 API 服务器地址 | URL 字符串 |

### 安卓版本

我不知道怎么在本地弄，因为我的电脑都没安装 Android SDK，请看 Action