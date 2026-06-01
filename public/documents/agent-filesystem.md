# Agent 与文件系统

AiChat 具有本地 Agent 能力，可以通过可选后端实现对服务器文件系统的读写操作和命令执行。

## 启用文件系统访问

1. 启动后端服务（开发模式下 Vite 自动启动）
2. 在对话中告诉模型需要启用文件系统访问（或模型认为需要）
3. 模型会调用 `use` 工具启用 `fs` 工具组
   - 或用命令开启
   - 或自行构造`use`工具调用

文件系统的根目录为 `./data/workspace/`（可在启动参数中指定）。

## 安全建议

**命令执行没有沙盒**。如果在对话中允许模型执行命令，它可以在服务器上执行任意命令。

**建议**：
- 在容器中运行后端的[文件服务模式](#documents/agent-filesystem.md:containerd模式)：`--workspace <path>` 限制文件访问范围
- 使用 Docker 等容器技术隔离环境
- 审查模型的命令执行请求

# Hashline 机制

Hashline 并不是 AiChat 的原创，但很有用，专为提升大模型进行**部分文件修改**的准确性而设计。

### 为什么需要 Hashline

传统文件编辑方式存在两个问题：
1. **全文替换**：要求模型输出完整文件内容，浪费 Token 且容易出错
2. **模糊定位**：基于行号的编辑在文件被修改后，行号可能偏移

Hashline 通过给每一行附加一个 SHA-1 哈希标签来解决这些问题。

### 工作原理

每行代码的格式为：

```js
1#a3f2  import React from 'react';
2#b4d1  import { useState } from 'react';
3#c5e7  
4#d6a8  function App() {
5#e7b3    return <div>Hello</div>;
6#f8c4  }
```

### 编辑文件流程

1. **读取文件**：模型读取带 Hashline 的文件内容
2. **指定范围**：模型用 `start_anchor` 和 `end_anchor` 指定要修改的范围，如 `3#c5e7` 到 `5#e7b3`
3. **提交修改**：模型提交替换内容
4. **验证**：服务端验证锚点是否匹配
5. **应用**：验证通过后应用修改，返回新的 Hashline


# 完全编辑模式
传统 Agent 的工作流是线性的、自动的、不可逆的：
- 模型调用工具 → 出错了？重来。
- 上下文偏了？插一条 user 消息，但之前的错误响应甚至思考已经污染了历史。
- 想改初始消息？请结束对话重新开始。

所以，我和[DsChat](https://github.com/huzpsb/DsChat)允许你：
- 修改历史中任何一条工具调用的参数和结果（“就当它成功过”）。
- 修改模型的思考过程（纠正错误推理，而不只是纠正输出）。
- 动态修改系统提示（让 Agent 即时转变目标）。
- 用“人类工具”将人变成 Agent 可调用的工具，比如 `find_import`——人直接告诉模型结果，而不需要它自己去读文件搜索。
    - （该功能尚未通过GUI实现，只有API）
- 除了DsChat没有任何其它Agent支持（DsChat后端必选，只支持DeepSeek，但是有更多网络爬虫工具）
- 你说这像单步调试，***But WHY NOT ?***

这让你可以像调试程序一样调试 Agent 的文件操作，甚至**帮它读取多个文件**省去多次输入处理的费用。  

### 如何使用

在消息上点击编辑按钮，即可修改对应内容。后续对话将基于修改后的内容继续。  
你也可以打开 `设置 > 数据管理 > 编辑当前对话的原始数据` 实时编辑 (小心数据丢失，因为是实时保存的)

### 鸣谢
- [**huzpsb**](https://github.com/huzpsb)
    - 你不能只在自己红温的时候支持模型应该能被打断和修改
    - 本项目允许你修改工具调用的名称、参数和结果，以及 Human as tool 的*灵感*完全来自该项目

# 后端使用和规范

## Containerd模式

通过 `--workspace <path>` 参数启动后端，限制 Agent 的文件系统访问范围：

```bash
node server.js --workspace /opt/agent-workspace --data ./data
```

此模式下：
- 文件系统 API 被限制在 workspace 目录内
- 无法限制 spawn_process 运行的程序
- 请使用容器、虚拟化或沙箱技术自行保证命令安全

## 开发模式

使用 `npm run dev` 启动时，后端自动挂载，文件系统根目录为 `./data/workspace/`。

## API 端点

| 端点 | 方法   | 说明                 |
|------|------|--------------------|
| `/api/v2/:userId/fs/read` | POST | 读取文件（支持行范围、锚点格式）   |
| `/api/v2/:userId/fs/read_image` | POST | 读取图片文件             |
| `/api/v2/:userId/fs/write` | POST | 写入/创建文件            |
| `/api/v2/:userId/fs/patch` | POST | 基于 Hashline 锚点的部分修改 |
| `/api/v2/:userId/fs/replace` | POST | 简单查找替换             |
| `/api/v2/:userId/fs/list` | POST | 列出目录内容（支持 glob）    |
| `/api/v2/:userId/fs/stat` | POST | 文件/目录元数据           |
| `/api/v2/:userId/fs/copy` | POST | 复制或移动文件            |
| `/api/v2/:userId/fs/delete` | POST | 删除文件/目录            |
| `/api/v2/:userId/fs/mkdirs` | POST | 递归创建目录             |
| `/api/v2/:userId/fs/spawn` | POST | 命令执行               |
| `/api/v2/:userId/fs/env` | GET  | 获取环境信息(提示文本)       |