---
name: 'agent-definition-howto'
description: 'How to write Agent definitions for CreateAgent.'
---

# 编写子代理

系统自动从 `/agents` 和 `~/.skills/agents` 读取子代理定义，它们必须包含 name 字段以生效。  
你只应该把项目通用/全局通用的子代理放在这两个目录。  
不具备此种通用性的子代理定义，应当放在别处，它们的 name 和 description 也不会被系统读取

子代理定义使用 frontmatter：
```yaml
# 全局唯一名称 建议 kebab-case
name: code-reviewer
# 一句话描述何时使用
description: Reviews code for quality and best practices. Use proactively after writing or modifying code.

# 空格分隔允许使用的工具 默认继承 (与参数中的 tools 拼接/追加)
tools: Read
# 引用的预设ID，注意是预设ID不是模型ID 默认继承
# 如果指定的预设无法找到，创建将失败
model: inherit
# 最大连续工具调用次数（收到其它代理的消息或通知时重置） 默认200
maxToolTurns: 300
# 最大总消息数 默认无限制
maxTurns: 500
# 文件系统配置（见下文） 默认继承
mounts:
   '/': { fs_type: "api", fs_server: "沙箱1" }
   '.skills': { fs_type: "db", fs_base: "skills" }
   # 使用这个（扩展运算符），继承文件系统，而不是覆盖
   '...': true

# 你可以指定子代理的文件系统
overlay: { mode: 'master' }

# 控制子代理的文件系统权限
acl: 'path/to/acl/file'

# 使用 gitignore 语法在 Glob 中排除项目
ignore: 'path/to/gitignore'


# 技能名称或可访问的本地文件，读取并注入系统提示（从mounts定义的文件系统读取！）
skills:
 - some-skill
 - ./balabala.txt

# 覆盖调用处的 background 参数
background: true

# 自动激活的 MCP 服务器名称
# 实质上是AiChat工具模块的名称
# 可以填写内置模块或插件注册的模块，甚至是隐藏模块，但不保证可用性
# 记忆可以填 Memory
# 不要启用需要用户交互的工具，部分工具静默降级（AskUser自动选第一个），部分工具直接报错
mcpServers:
 - Exa
 # 暂不支持内联定义
 - {
      name: "Exa",
      url: "https://mcp.exa.ai/mcp",
      key: "sk-xxxx",
      # 给MCP服务器的所有工具加上 name 下划线 作为前缀。如果MCP已经有前缀就没必要开
      # prefix: true
   }

# 重定向配置，详见下文
redirect: { target: "file", path: "asd.txt", id: 0 }

# 子代理类别 (basic之外的类别都是插件注册的，类别无效会导致创建失败)
# 目前唯一注册的: BasicRoleplay 插件 支持设置 kind: character
# 然后必填 character string 指向一张存在的角色卡名称
kind: basic
---

正文：子代理系统提示词
```

## 文件系统

```typescript
    type Mount = {
        fs_type: 'db' | 'api' | 'local' | 'opfs';
        fs_base?: string; // 可选，设置根目录为某个子目录
        fs_server?: string; // 仅 api 类型需要：服务器名
        fs_name?: string; // 文件系统名称
    }
```

### 类型

- db: 云端文件系统
- api: 容器文件系统
- local: 本地文件系统
- opfs: 浏览器私有文件系统

> 只有 api 文件系统可以运行 shell 命令，其他文件系统仅可用 `RunJS` 沙箱  
> 传入只包含 `fs_name` 键的对象在运行时让用户选择实现

### 位置

- `/`: 挂载到根目录
- `a` (其他所有): 挂载到 `~/a`
- `...`: 代码检测特殊键名，不是真实路径

## 工具

想让子代理的输出符合特定格式，简单点可以给它 `ValidateJson` 和 schema 路径，然后让它写入文件并自己验证。  
复杂点可以重定向到脚本。  
如果没有JSON相关工具，请激活 `JsonEditor` 模块。

给子代理 `CreateAgent` 可以递归，深度由用户限制。  
如果允许递归，别忘了给 `NotifyAgent` 等工具

## 重定向

```js
const redirectSchema = {
    oneOf: [
        {
            type: "object",
            properties: {
                target: { enum: ["file", "javascript"] },
                path: { type: "string" },
                id: { type: "integer", description: "Agent id to send ping notifications to." }
            },
            required: ["target", "path", "id"]
        },
        {
            type: "object",
            properties: {
                target: { const: "agent" },
                id: { type: "integer" }
            }
        },
    ]
};
```

id: 在脚本或文件写入完成后发送消息给这个代理，脚本的控制台输出也被重定向到它。

触发时机是每轮回复结束，也就是任何 finish_reason 非 tool_calls 的消息。

特殊值，只能在 frontmatter 里使用：
- 0 = 创建者（你）
- -1 = CreateAgent 的参数 redirectTarget

target=javascript 时，path必须指向（子代理文件系统中的）ESM模块，它 runs in an isolated basic (permissions=[]) RunJS sandbox with 60 seconds timeout and:
- process.env environments:
    - AGENT_ID: number # 子代理 ID
    - AGENT_OWNER: number # 子代理创建者 ID
    - AGENT_ERROR: boolean
    - AGENT_RESPONSE: string # 代理的回复内容，或者错误详情
- "agents" module:
  ```js
  import { notifyAgent, retry } from "agents";
  // PASS THROUGH, no XML tags will be appended.
  await notifyAgent(1, "example"); // id, content
  // sent back to the agent 来实现 ReAct 循环等高级特性.
  // Note: retry always throw a special Error name="RetryError"
  if (retryCount < 10)
    await retry("格式不符合要求，再试一次");
  ```
- 使用文件系统保存重试次数避免无限循环
- 务必在 AGENT_ERROR = true 时中止循环并通知，否则脚本会把错误吞掉

## Access Control List

井号注释
每行一条规则
语法：`!?[+-][rwl]+ <pattern>`

- `!`: 重要，使用该标记的规则无法被非重要规则覆盖。  
- `+`: 允许权限
- `-`: 拒绝权限
- 拒绝优先允许，所以被重要规则拒绝的路径无法再次开放

- `r`: 读取
- `w`: 写入
- `l`: 列出项目

规则按特异性排序，而不是定义顺序，优先级如下：

1. '*' -> 默认规则
2. '*.ext' -> 扩展名规则
3. 'name' -> 文件名规则
4. 'name/' -> 路径段落规则
5. '/test/' -> 路径前缀规则
6. '/test/*.jpg' -> 前缀扩展名规则
7. '/test/a.jpg' -> 文件前缀规则

