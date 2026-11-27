# 构建指南

> 首先可以在 [Release](https://github.com/Roj234/ai-chat/releases) 中直接下载构建好的版本  
> 如果你确实想开发，请继续看  
> 这个文件不会经常更新，所有未提到的内容请看 Action 构建脚本

## 前置要求

- 安装 **Node.js 22+** (建议使用 Node 24 LTS)
- 根据 [Github Action](/.github/workflows/build.yml) 中的构建脚本初始化项目

## 启动开发服务器

```bash
npm run dev
```

启动后访问 `http://localhost:5173` 即可使用。开发模式下构建工具（`@roj234/ie`，Vite 兼容）会自动把可选后端挂到同一个端口，数据目录为 `./data`。

## 构建生产版本

```bash
# 构建（客户端 + 服务端）
npm run build

# 或者，分别构建

# 构建客户端
npm run build:client
# 构建服务端
npm run build:server
# 构建安卓版客户端（使用 vite.app.config.js）
npm run build:app

# 预览构建结果
npm run preview
```

构建产物位于 `dist/` 目录。

## 部署

见 README。

#### 命令行参数

| 参数                   | 说明   |
|----------------------|------|
| `-a <addr>`          | 监听地址 |
| `-p <port>`          | 监听端口 |
| `-c config.js`       | 配置文件路径 |
| `--data <path>`      | 数据存储目录 |
| `--static dist.zip`  | 静态提供 Zip/Brip 中的前端 |
| `--workspace <path>` | 以此为工作区根目录启动专用文件服务 |
| `--cert <path>`      | 指定证书目录以启用 HTTPS |
| `--hide-user`        | 在命令输出中隐藏当前用户名 |

- 只有专用文件服务，才能执行命令。
  - 设计用途：用户在沙盒中运行专用文件服务，并暴露 HTTP 端口。

### 开发后端

使用 `npm run dev` 时，`@roj234/ie` 会自动构建并启动后端（`backend/server-dev.js`）并挂载到开发服务器。  
首次启动时，若 `backend/config.js` 不存在，会自动从 `backend/config.default.js` 复制。

## 构建选项

`vite.config.js` 的 `define` 中注入以下构建期常量（源码里直接当全局变量用）：

| 变量 | 说明 | 取值 |
|------|------|------|
| `APP_NAME` | 应用名 | 取自 `package.json` |
| `APP_VERSION` | 版本号 | `package.json` 的 version；桌面构建在无 `BUILD_NUMBER` 时追加 ` (dev)` |
| `DB_MODE` | 数据库模式 | 固定 `mixed`（历史可选 `local` / `remote` / `mixed`） |
| `IS_ANDROID_BUILD` | 是否安卓构建 | `true` / `false` |
| `BUILD_NUMBER` | 构建号 | 环境变量或 git commit + 时间 |
