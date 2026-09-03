# 编写技能

技能是包含 YAML Frontmatter 的 Markdown 文件，格式如下：
```markdown
---
name: 名称
description: >-
  描述
# 依赖的工具
allowed-tools: Read Write Grep
# 隐藏
disable-model-invocation: true
---
技能正文（Markdown）
```
`name` and `description` are required，它们会被系统提取并注入上下文。
All other keys are optional。
`disable-model-invocation`: 不注入上下文，无法被你看到，只能在用户提到后通过 Skill 工具调用

Skill 工具返回正文和技能路径。
Read 工具通过路径读取完整的文件内容。

## 路径

`~/.skills/文件夹名/SKILL.md`
技能名字来自 name 键，文件夹名任选但建议相同

## 语法

系统支持的 YAML Frontmatter 是一个很小的子集

仅支持：
- 行首注释
- Inline Scalar / Block Scalar
- Mapping / List
- Inline JSON5 (必须符合 JSON5 标准, 回退到 Inline String)
- Nesting (通过缩进)

不支持：
- 行内注释
- 混合使用 List 和 Mapping `- a: b`
- 所有未显式提到的特性

# 编写子代理

系统自动从 `/agents` 和 `~/.skills/agents` 读取子代理定义并注入系统提示，这些定义必须包含 name 字段。  
你只应该把项目通用/全局通用的子代理放在这两个目录。  
不具备通用性的，其它位置的子代理定义，name 和 description 不会被系统读取

子代理定义同样使用 frontmatter：
```yaml
# 全局唯一名称 建议 kebab-case
name: code-reviewer
# 一句话描述何时使用
description: Reviews code for quality and best practices. Use proactively after writing or modifying code.

# 空格分隔允许使用的工具 默认继承 (与参数中的 tools 拼接/追加)
tools: Read
# 引用的预设ID，注意是预设ID不是模型ID 默认继承
model: inherit
# 最大连续工具调用次数（收到其它代理的消息或通知时重置） 默认200
maxToolTurns: 300
# 最大总LLM调用次数 默认无限制
maxTurns: 500
# 虚拟文件系统配置（键为根路径，值为下面TS定义的Mount对象） 默认继承
mounts:
   '/': { fs_type: "api", fs_server: [ "http://127.0.0.1:8080", "" ] }
   '.skills': { fs_type: "db", fs_base: "skills" }
   # 使用这个（扩展运算符），继承文件系统，而不是覆盖
   '...': true

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

# 见下文
redirect: { target: "file", path: "asd.txt", id: 0 }

# 子代理类别 (basic之外的类别都是插件注册的，类别无效会导致创建失败)
# 目前唯一注册的: BasicRoleplay 插件 支持设置 kind: character
# 然后必填 character string 指向一张存在的角色卡名称
kind: basic
---
```

db local opfs 只需 fs_base 它代表文件夹名称/根目录  
api 还需 fs_server 格式为数组 [url, accessToken]  
config 不需要任何参数并且是单例  
vfs 只能由代码构造
```typescript
    type Mount = {
        fs_type: 'db' | 'api' | 'local' | 'config' | 'opfs' | 'vfs';
        fs_base?: string;
        fs_server?: string | string[];
        fs_builtin?: string;
    }
```

> 如果想让子代理的输出符合特定格式，给它 ValidateJson 和 schema。  
> 如果没有这个工具，让用户激活 `JSON编辑器` 模块。

> 给子代理 CreateAgent 可以递归创建，但深度由用户限制。
> 如果允许递归，别忘了同时给 NotifyAgent 等工具

# 重定向子代理 (redirect 配置键)

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