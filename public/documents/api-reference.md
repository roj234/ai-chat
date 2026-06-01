# API 参考

AiChat 可选后端提供 RESTful API，基础路径为 `/api/v2/:userId/`。
- 每个功能通过Router类注册 (见 `backend/init.js`)

## SSE 代理

### 发起对话

```http
POST /api/sse/v1
POST /api/v2/:userId/sse/v1
```

OpenAI 兼容的 Chat Completions 端点。请求体和响应格式遵循 [OpenAI API 规范（可直连）](https://github.com/openai/openai-openapi)。

我在返回的第一个 chunk 中加了一个字段，通过这个字段检查是否是否可以继续
`chunk.resumable = { start: startTime, ft: Date.now() };`
其中 start 是请求开始的时间， ft 是收到上游第一个 chunk 的时间，用于前端计算
如果 resumable 字段存在，那么当前 chunk 的 id 就会被存入可继续接口

### 恢复对话

```http
POST /api/sse/v1/resume/:id
POST /api/v2/:userId/sse/v1/resume/:id
```

恢复中断的流式响应。当客户端掉线后，可通过此端点继续接收未完成的回复。  
本质上是通过applyDelta把所有的delta打包成新的首包，这个接口直接返回SSE

### 中止对话

```http
POST /api/sse/v1/abort/:id
POST /api/v2/:userId/sse/v1/abort/:id
```

因为无法再通过断开连接来中止推理，客户端中止时会调用这个接口

## 批量请求

```http
POST /api/v2/:userId/batch
```

统一批量端点，支持一次性执行多个操作（消息、KV、日志、Blob）。请求体为操作数组：

```json
[
  [ "message/upsert", { ... } ],
  [ "kv/set", { ... } ],
]
```

详细请查看 `db-remote.js` 或后端代码，我更建议把他们扔给 LLM

## 文件系统 API

文件系统 API 需要后端并在前端配置单独的文件访问地址。
> 你可以使用 /basepath 指令设置子目录为新的根目录，但这无法限制 spawn_process

有关具体的 HTTP API 请直接查看 `tools/filesystem.js`
[或者这里](#documents/agent-filesystem.md:API-端点)

### 环境信息

```http
GET /api/v2/:userId/fs/env
```

返回当前工作环境信息（系统、Node 版本、工作目录等）。

## 搜索

```http
GET /api/v2/:userId/search?q=关键词&type=semantic
```

| 参数 | 说明                                          |
|------|---------------------------------------------|
| `q` | 搜索关键词                                       |
| `type` | `keyword` 或 `semantic` 或省略（语义搜索需要后端配置向量 DB） |

## 数据库维护

```http
DELETE /api/v2/:userId/database
```

触发数据库压缩和日志清理。

## WebSocket 同步

```
ws://host:port/api/v2/:userId/sync
```

实时多客户端数据同步：
- 自动消息流转
- 悲观锁冲突解决
- 支持序列化 Blob、Set 等复杂类型

## 压缩与序列化

API 支持以下编码方式（通过 `Content-Type` 和请求头控制）：

| 格式 | Content-Type |
|------|-------------|
| JSON | `application/json` |
| Msgpack | `application/msgpack` |
| Brotli | `Content-Encoding: br` |

Msgpack + Brotli 组合可显著减小传输体积和序列化开销。

## 错误响应

所有 API 在出错时返回统一的错误格式：

```json
{
  "error": "错误描述信息"
}
```

HTTP 状态码遵循 REST 惯例。  
batch 接口在部分失败时返回 200

## 配置后端 API 行为

[这里](#documents/backend-config.md)