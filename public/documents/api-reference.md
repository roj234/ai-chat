# API 参考

AiChat 后端提供三类服务，可通过命令行参数控制：

| 启动方式                         | 可用服务 |
|------------------------------|----------|
| 默认（`node server.js`）         | SSE Proxy + 数据库服务 + 文件服务（无命令执行） |
| 专用文件服务（`--workspace <path>`） | 仅文件服务（含命令执行） |

---

## 1. SSE Proxy（LLM 代理）

SSE Proxy 负责将前端的 LLM 请求代理转发到上游 API，同时支持会话恢复、中止和调试追踪。

### 1.1 路由前缀 (仅适用于本项目参考实现，自行实现无需考虑)

| 前缀 | 适用场景 |
|------|----------|
| `/api/sse/v1` | 无需用户隔离（单用户部署） |
| `/api/v2/:userId/sse/v1` | 多用户部署，userId 关联数据库 |

所有 SSE Proxy 端点均需要通过 `Authorization: Bearer <key>` 认证，key 匹配 `config.js` 中 `SSE_PROXY_BACKEND` 的键名。

### 1.2 端点列表

#### 模型列表

```http
GET /v1/models
```

#### 对话/补全接口

```http
POST /v1/chat/completions
POST /v1/completions
```

请求体和响应格式遵循 [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)。

**查询参数**：

| 参数 | 说明           |
|------|--------------|
| `blobProxy` | 代理发送Blob节省流量（未实现） |

**响应**：`text/event-stream`（SSE 流），首个 chunk 的 `resumable` 字段包含会话恢复信息：

```json
{
  "id": "chatcmpl-xxx",
  "resumable": {
    "start": 1721000000000,
    "ft": 1721000001234
  }
}
```

其中 `start` 为请求开始时间，`ft` 为收到上游首字节时间（毫秒时间戳）。如果 `resumable` 存在，该会话可被恢复。

对非流式响应（上游返回纯 JSON），后端返回 `application/json`。

#### 恢复会话

```http
POST /v1/resume/:id
```

当客户端在 SSE 流中断后重连时使用。后端将已收到的所有 delta 合并为一个完整消息，作为 SSE 首包返回，然后继续推送后续 chunk。

**响应**：`text/event-stream`

#### 中止会话

```http
POST /v1/abort/:id
```

由于 SSE 代理模式下断开 HTTP 连接无法中止上游推理，客户端需显式调用此端点。

**响应**：`{ "success": true }`

---

## 2. 文件服务

文件服务提供文件系统操作和（可选）命令执行能力。基础路径为 `/api/fs`，所有端点使用 POST 方法，请求体为 JSON。  
这些参数的格式和工具Schema定义的参数完全相同，ground truth是工具Schema。

### 2.1 安全模型（参考实现）

- **路径隔离**：所有文件操作限制在 `--workspace` 指定的目录内，禁止路径穿越
- **Ignore 规则**：支持根目录下的 `.gitignore` / `.ignore` 文件（操作被忽略的路径返回 403）
- **命令执行**：仅在 `--workspace` 模式下启用

### 2.2 文件操作

#### 检测可用性

```http
POST /api/fs/ping
```

**请求体**：
```json
{
  "nonce": "string"
}
```

**响应**：
```js
{
	// 小写 hex
	pong: sha256(nonce + "AiChat").toHex()
}
```

#### 读取文件

```http
POST /api/fs/read
```

**请求体**：
```json
{
  "path": "string",
  "offset": 10,
  "limit": 100,
  "format": "lineNumber"
}
```

**响应**：
- 文本文件：`text/plain`，自动检测编码（UTF-8 / GB18030），含 BOM 检测
- 图片文件（png/jpg/jpeg/bmp/webp）：`image/<type>`，二进制流
- 文件超过 10MB 返回 `400`

#### 写入文件

```http
POST /api/fs/write
```

**请求体**：
```json
{
  "path": "relative/path/to/file.txt",
  "content": "文件内容"
}
```

自动创建父目录。使用哈希行（HashLine）协议确保幂等性。

#### 追加内容

```http
POST /api/fs/append
```

**请求体**：
```json
{
  "path": "relative/path/to/file.txt",
  "content": "追加内容",
  "newline": true
}
```

`newline`（默认 `true`）：如果文件末尾没有换行，自动插入一个。

#### 差异更新（Patch）

```http
POST /api/fs/patch
```

**请求体**：
```json
{
  "path": "relative/path/to/file.txt",
  "patches": [
    { "old": "原文本", "new": "新文本" }
  ]
}
```

基于哈希行的增量更新，支持字符串级 diff/patch，具有幂等保证。

#### 编辑（Edit）

```http
POST /api/fs/edit
```

**请求体**：
```json
{
  "path": "relative/path/to/file.txt",
  "old": "待替换文本",
  "new": "替换文本"
}
```

先验证文件内容与 `old` 匹配（通过哈希行），然后替换为 `new`。失败时不修改文件。

#### 文件信息

```http
POST /api/fs/stat
```

**请求体**：`{ "path": "..." }`

**响应**：`text/plain`
```
type: file
mode: -rw-r--r--
size: 1234
atime: 2026-07-18T08:00:00.000Z
mtime: 2026-07-18T08:00:00.000Z
ctime: 2026-07-18T08:00:00.000Z
nlink: 1
```

#### 列出目录

```http
POST /api/fs/list
```

**请求体**：
```json
{
  "path": "subdir",
  "glob": "*.js",
  "json": false
}
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `path` | — | 目录路径（相对沙盒根目录） |
| `glob` | `"*"` | glob 匹配模式 |
| `json` | `false` | `true` 时返回 JSON 数组，否则返回 TSV 文本 |

**响应（json=false）**：`text/plain`，每行 `name\ttype\tsize`，最多 500 条。
**响应（json=true）**：`[["name", "file", 1234], ["dirName", "dir"]]`，不限制数量，用于前端实现 glob

#### 创建目录

```http
POST /api/fs/mkdir
```

**请求体**：`{ "path": "a/b/c" }`

递归创建，已存在不报错。

#### 复制/移动

```http
POST /api/fs/copy
```

**请求体**：
```json
{
  "src": "source.txt",
  "dest": "target.txt",
  "move": false
}
```

`move: true` 时执行移动（重命名）。

#### 删除

```http
POST /api/fs/delete
```

**请求体**：`{ "path": "file.txt" }`

递归删除文件或目录。不允许删除根目录。

### 2.3 命令执行

> 默认仅在 `--workspace` 模式下可用。

#### 环境信息（构造系统提示词）

```http
GET /api/fs/env
```

**响应**：
```json
{
  "prompt": "os: Linux\nshell: bash\nnode: v22.0.0\n..."
}
```

返回系统环境摘要（OS、Shell、已安装工具等），填充系统提示词。

#### 执行程序

```http
POST /api/fs/spawn
```

**请求体**：
```json
{
  "program": "git",
  "arguments": ["status", "--short"],
  "cwd": "project",
  "timeout": 10,
  "noTruncate": false
}
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `program` | — | 可执行程序名称 |
| `arguments` | — | 参数数组 |
| `cwd` | `""` | 工作目录（相对沙盒根目录） |
| `timeout` | `10` | 超时秒数（最大 275 秒） |
| `noTruncate` | `false` | 禁止截断输出 |

**行为**：
- 输出 ≤ 20KB：直接返回 stdout+stderr 交错内容
- 输出 > 20KB：头部和尾部各保留 10KB，中间部分写入 `command-log-<timestamp>.log` 文件

**响应**：`text/plain`
```
Exit code 0
<stdout/stderr 交织内容>
```

#### 执行 Shell 命令

```http
POST /api/fs/shell
```

**请求体**：
```json
{
  "command": "ls -la && cat file.txt",
  "cwd": "project",
  "timeout": 10
}
```

**响应**：同 `/spawn`。

#### 启动后台进程

```http
POST /api/fs/run_bg
```

**请求体**：
```json
{
  "program": "npm",
  "arguments": ["run", "dev"],
  "cwd": "project",
  "timeout": -1
}
```

`timeout` 为 `-1` 表示无超时（需手动停止）。

**响应**：
```json
{
  "status": "Running in background",
  "programId": "a1b2c3d4",
  "logFile": "bg-program-a1b2c3d4.log"
}
```

进程的 stdout/stderr 全部写入 `logFile`，LLM 可通过 `/read` 查看。

#### 终止后台进程

```http
POST /api/fs/stop_bg
```

**请求体**：`{ "programId": "a1b2c3d4" }`

先发送 SIGTERM，3 秒后发送 SIGKILL。

**响应**：
```json
{
  "status": "killed",
  "logFile": "bg-program-a1b2c3d4.log"
}
```

---

## 3. 数据库服务

数据库服务提供对话、消息、KV 存储、日志、Blob 和搜索功能。基础路径为 `/api/v2/:userId`。

### 3.1 认证

如果 `config.js` 中 `INTERACTIVE_LOGIN` 为 `true`，所有数据库端点需要通过 PAT（个人访问令牌）认证：

```
Authorization: Bearer <pat-token>
```

例外：`/login` 端点和 Blob 下载端点不需要认证。

#### 交互式登录

```http
POST /api/v2/:userId/login
```

**查询参数**：`?desc=设备描述`（未实现）

**响应**：`text/event-stream`

```
data: {"code":"123456"}
data: {"token":"<pat-token>"}
data: [DONE]
```

流程：
1. 客户端请求登录，获得 6 位配对码
2. 服务端控制台打印配对请求（含 IP、User-Agent、设备描述）
3. 管理员在控制台输入 `/accept 123456` 或 `/deny 123456 [原因]`
4. 60 秒超时自动拒绝

### 3.2 批量请求（事务）

```http
POST /api/v2/:userId/batch
```

**请求体**：操作数组，每个元素为 `[操作名, 参数]`：

```json
[
  ["conversations", null],
  ["kv/set", ["myKey", "myValue"]],
  ["version", null]
]
```

**响应**：结果数组，与请求一一对应：
```json
[
  [{ "id": 1, "title": "对话1", "time": 1721000000000 }],
  true,
  [3]
]
```

部分操作失败时，HTTP 状态码仍为 200，失败项在数组中返回 `{ "error": "..." }`。  

所有 `upsert` 接口都需要支持 diff/patch 语义，兼容 Unconscious 库 diff 格式。

log/insert省略id时取同事务上一个message/upsert的id  
message/upsert省略owner时取同事务上一个conversation/upsert的id  

#### 3.2.1 对话操作

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `conversations` | `timestamp?` | `{id, title, time}[]` | 列出所有对话。若传入时间戳且无变更返回 `{"error":{"status":304}}` |
| `conversation` | `[id, timestamp?]` | conversation 对象 | 获取单个对话元数据，时间戳匹配时跳过消息加载 |
| `conversation/upsert` | `{id?, title?, time?, ...data}` | `id`（number） | 创建或更新对话。`$: "SET"` 表示全量替换 |
| `conversation/delete` | `id` | `boolean` | 删除对话及其所有消息 |

#### 3.2.2 消息操作

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `messages` | `conversationId` | `Message[]` | 列出对话的所有消息，按 ID 排序（system 消息优先） |
| `message/upsert` | `{id?, owner, content, time?, ...data}` | `id`（number） | 创建或更新消息。 |
| `message/delete` | `id` | `ownerId`（number）或 `false` | 删除消息 |

#### 3.2.3 KV 存储

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|-------|------|
| `kv` | `key` | `any` | 获取键值 |
| `kv/set` | `[key, value]` | `true` | 设置键值（REPLACE） |
| `kv/delete` | `key` | `boolean` | 删除键值 |

#### 3.2.4 KVS（键值集合）

KVS 用于存储类型化数据（如预设、角色卡、世界书），每条记录有 `type`、`name` 和 `data`。

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `kvs` | `type` | `{name}[]` | 列出某类型的所有条目名称 |
| `kvs/values` | `type` | `{type, name, data}[]` | 列出某类型的所有条目（含数据）。`type="*"` 获取全部 |
| `kvs/value` | `[type, name]` | `{type, name, data}` | 获取单条记录 |
| `kvs/upsert` | `{type, name, ...data}` | `true` | 创建或更新 |
| `kvs/delete` | `[type, name]` | `boolean` | 删除记录 |

#### 3.2.5 日志

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `log` | `id` | log 对象 | 根据 message_id 查询日志 |
| `log/by-rowid` | `rowid` | log 对象 | 根据日志表 ROWID 查询完整日志 |
| `log/insert` | `{id, time?, ...data}` | `boolean` | 写入日志。 |

#### 3.2.6 Blob（附件）

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `blob` | `hash`（base64url） | `{name, type, size, lastModified}` | 获取附件元信息 |

#### 3.2.7 系统

| 操作名 | 参数 | 返回值 | 说明 |
|--------|------|--------|------|
| `sync` | `null` | WebSocket URL 字符串 | 获取实时同步连接地址 |
| `version` | `null` | `[3]` | 通信协议版本号 |

### 3.3 独立端点

#### 日志列表

```http
GET /api/v2/:userId/logs
```

**查询参数**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `start` | `0` | 起始时间戳（毫秒） |
| `end` | `Date.now()` | 截止时间戳（毫秒） |

**响应**：日志数组（最多 5000 条），不含 `request_id` 和 `usage` 字段以减少体积。

#### 数据库维护

```http
DELETE /api/v2/:userId/database
```

执行操作：
1. 遍历日志，通过 `LOG_HOOK` 清理/更新（如 `'SKIP'` 的删除）
2. 清理对话和消息数据中的冗余字段（`id`, `title`, `time`, `owner`）
3. 执行 `VACUUM` 和 `WAL checkpoint (TRUNCATE)` 回收磁盘空间

**响应**：`{ "success": true }`

#### 计费数据回填

```http
POST /api/v2/:userId/database/fetch
```

目前仅支持从 ZenMux API 拉取计费信息，回填到日志记录中。  
需要 `data/zenmux-token.txt` 文件中的 API token。

**响应**：`{ "updated": 3 }`（更新的记录数）

#### 搜索

```http
GET /api/v2/:userId/search
```

**查询参数**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `keyword` | —（必填） | 搜索关键词 |
| `mode` | — | `"semantic"` / `"keyword"` / 省略（混合） |
| `limit` | `50` | 返回的最大对话数（≤100） |

**响应**：对话数组，每个对话含 `id`、`title`、`time` 和匹配的 `messages`。语义搜索命中的 message 对象附带 `cossim` 字段（余弦相似度）。

### 3.4 WebSocket 同步

```
ws://host:port/api/sync?u=<userId>&t=<pat-token>
```

实时多客户端数据同步。连接成功后收到 `SYNC_INIT` 消息。

**消息类型**（`[type, data]` 格式）：

| 类型码 | 名称 | 方向 | 说明 |
|--------|------|------|------|
| `0` | `SYNC_INIT` | S→C | 连接初始化：`[客户端数, 已锁定对话ID列表, 我的客户端ID, 计数器]` |
| `1` | `SYNC_LOCKED` | C→S / S→C | 锁定对话（写锁）/ 通知他人 |
| `2` | `SYNC_UNLOCKED` | C→S / S→C | 解锁对话 |
| `3` | `SYNC_RESOLVE` | C→S | 强制解锁（升级读锁为写锁） |
| `4` | `SYNC_CONFLICT` | S→C | 通知对话已被他人锁定（降级为读锁） |
| `5` | `SYNC_RELEASED` | S→C | 通知写锁持有者：所有读者已释放 |
| `6` | `SYNC_READERS` | S→C | 读锁持有者数量变更 |
| `7` | `SYNC_PING` | 双向 | 心跳 |
| `8` | `SYNC_ERROR` | S→C | 错误（随后关闭连接） |
| `9` | `SYNC_CONVERSATION` | S→C | 对话创建/更新 |
| `10` | `SYNC_CONVERSATION_DEL` | S→C | 对话删除 |
| `11` | `SYNC_MESSAGE` | S→C | 消息创建/更新 |
| `12` | `SYNC_MESSAGE_DEL` | S→C | 消息删除 |
| `13` | `SYNC_KV` | S→C | KV 变更 |
| `14` | `SYNC_KVS` | S→C | KVS 条目变更 |
| `15` | `SYNC_KVS_DEL` | S→C | KVS 条目删除 |

**编码**：JSON 或 Msgpack（由 `RESPONSE_USE_MSGPACK_SCHEMA` 配置控制）。

**消息大小限制**：4KB。

---

## 4. 编码与压缩

客户端需同时满足两个条件才能使用 Msgpack 压缩：
1. `Accept` 头包含 `application/vnd.msgpack`
2. `X-SV` 头等于服务端的 `msgpack_schema_version`（在 `common/MsgpackSchema.js` 中定义）

参考实现还支持 Gzip 和 Brotli 压缩

---

## 5. 错误处理

### 统一错误格式

```json
{
  "error": "错误描述"
}
```
