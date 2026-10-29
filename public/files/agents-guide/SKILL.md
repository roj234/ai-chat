---
name: 'agent-guide'
description: 'How to write sub-agent definitions (frontmatter, mounts, ACL, redirect) and plan multi-agent workflows.'
---

# 子代理编写指南

## 定义文件的发现

系统自动扫描以下位置的 `*.md`，frontmatter 含 `name` 字段的才会注册为可用子代理：

- `./agents`（根文件系统下）
- `~/.skills/agents`（需激活 Skills 模块）

已注册定义的 `name` 和 `description` 会注入主代理的系统提示，主代理按名引用（`promptType: "name"`）。
因此这两个位置只应放项目通用/全局通用的子代理；不具备通用性的定义请放在其他路径，通过文件路径引用
（`promptType: "file"`）——它们不会被扫描，也不占用系统提示。

## Frontmatter 参考

```yaml
---
# 全局唯一名称 建议 kebab-case
name: code-reviewer
# 一句话描述何时使用
description: Reviews code for quality and best practices. Use proactively after writing or modifying code.

# 空格分隔的工具白名单；省略则继承调用方
tools: Read Grep Glob
# 引用的预设ID（是模型ID的超集） 默认继承
# 如果指定的预设无法找到，创建将失败
model: inherit
# 最大连续工具调用次数（收到其它代理的消息或通知时重置） 默认200
maxToolTurns: 300
# 最大总消息数 默认无限制
maxTurns: 500
# 覆盖调用处的 background 参数
background: true

# 文件系统配置（见下文） 默认继承
mounts:
  '/': { fs_type: api, fs_server: "沙箱1" }
  '.skills': { fs_type: db, fs_base: skills }
  # 使用这个（扩展运算符），继承调用方文件系统，而不是覆盖
  '...': true

# 控制子代理的根文件系统权限
acl: path/to/acl/file

# 使用 gitignore 语法在根文件系统的 Glob 中排除项目
ignore: path/to/gitignore

# 技能名称或可访问的本地文件，读取并注入系统提示（从mounts定义的文件系统读取！）
skills:
  - some-skill
  - ./balabala.txt

# 自动激活的工具模块，仅支持字符串（见下文）
mcpServers:
  - Exa

# 重定向配置，详见下文
redirect: { target: file, path: asd.txt, id: 0 }

# 子代理类别（见下文）
kind: basic
---

正文：子代理系统提示词
```

### mcpServers

实质上是 Aint 工具模块的名称：可以填内置模块、手动添加的MCP模块或插件注册的模块。例如记忆模块填 `Memory`。

- **目前仅支持字符串模块名**。内联对象定义（name/url/key）尚未实现。
- 不要启用需要用户交互的工具：部分工具静默降级（如 AskUser 自动选第一项），部分直接报错。

### 类别（kind）

`basic` 之外的类别由插件注册，类别无效会导致创建失败。
可能存在的类别：

- `character`（BasicRoleplay 插件）：同时必填 `character: <角色卡名称>`，指向一张已存在的角色卡。

## 文件系统（mounts）

每个挂载项的定义：

```typescript
type Mount = {
    fs_type: 'db' | 'api' | 'local' | 'opfs'; // 必填
    fs_base?: string;    // 可选，以某个子目录作为挂载根
    fs_server?: string;  // 仅 api 类型需要：服务器名
    fs_builtin?: boolean; // 内置挂载：运行时按环境自动选择实现（db → local → opfs）
}
```

| fs_type | 存储位置 |
|---|---|
| `db` | 云端（需后端） |
| `api` | 容器/后端服务器 |
| `local` | 本地文件夹 |
| `opfs` | 浏览器私有存储 |

挂载键的语义：

- `/`：挂载到根目录
- 其它任意键 `a`：挂载到 `~/a`
- `'...': true`：代码检测的特殊键名（不是真实路径），表示**额外继承**调用方的文件系统

继承规则：

- 不写 `mounts`：完整继承调用方的根文件系统与所有挂载。
- 写了 `mounts` 且含 `'...': true`：自定义挂载与继承的挂载合并，自定义优先。
- 写了 `mounts` 但不含 `'...'`：完全不继承，此时**必须显式定义 `/`**，否则子代理没有可用的根文件系统。

> 只有 `api` 文件系统可以执行 shell 命令，其它文件系统仅可用 `RunJS` 沙箱。

### 权限控制

| 能力 | db | api | local | opfs |
|---|---|---|---|---|
| ACL | ✗ | ✗ | ✓ | ✓ |
| `.ignore` 排除 | ✓ | ✓ | ✓ | ✓ |
| OverlayFS | ✗ | ✗ | ✓ | ✓ |

[ACL 语法参考](./ACL.md)；ACL 文件不存在或为空时不设限制。

## 工具配置建议

- 想让子代理的输出符合特定格式：简单场景给它 `ValidateJson` 和 schema 路径，让它写入文件并自行验证；复杂场景用 `redirect` 重定向到脚本（见下文）。没有 JSON 相关工具时，先激活 `JsonEditor` 模块。
- 给子代理 `CreateAgent` 可以递归创建，深度由用户设置限制（默认 3）。允许递归时，别忘了同时给 `NotifyAgent`、`TerminateAgent` 等工具。

## 占位符（argv 模板）

frontmatter 的任意字符串值中可以使用 `{{ }}` 占位符，取值来自调用时传入的 `argv` 数组：

```yaml
# 无默认值：缺少对应 argv 时创建失败
maxTurns: {{ argv0 }}

# 使用默认值
kind: {{ argv1 | "basic" }}

# 字符串中的插值
acl: path/to/{{ argv2 | "test.acl" }}
```

类型规则：

- 当**整个值就是一个占位符**（如上例的 `maxTurns`、`kind`），替换结果按 JSON5 解析，可得到数字、布尔、对象等类型。
  例：`argv = ["3"]` 时，`maxTurns` 的值是整数 `3`。
- 默认值原样保留引号，`{{ argv1 | "basic" }}` 缺省时替换为 `"basic"`——恰好是合法的 JSON5 字符串，因此类型依然正确。
- 占位符嵌在更长的字符串中时，结果永远是字符串。

因此可以为任何字段使用占位符，在调用时按需传入——例如下面的重定向。

## 重定向（redirect）

每轮回复结束（即任何 finish_reason 非 `tool_calls` 的消息）时触发，将本轮结果送往指定目标。
**设置 redirect 会强制后台运行**：创建调用立即返回，不等待子代理完成。

```yaml
# 追加写入文件，完成后向 id 指定的代理发送 ping 通知
redirect: { target: file, path: asd.txt, id: 0 }
# 交给 JS 脚本处理（见下）
redirect: { target: script, path: check.mjs, id: 0 }
# 直接把结果作为消息转发给另一个代理
redirect: { target: agent, id: 12 }
```

- `id`：file / script 目标在完成（或出错）后接收 `<agent-message role="ping">` 通知的代理 ID。
  回复本体进入文件/脚本，ping 只是通知（脚本目标的通知内容是脚本的控制台输出）。
  特殊值 `0` = 创建者（仅 frontmatter 中可用）；其它取值必须是当前会话拥有的代理，否则创建失败。
- file 目标为**追加写入**；子代理出错时写入内容带 `Agent error:` 前缀，脚本异常时通知内容带 `Script error:` 前缀。

### script 目标

`path` 必须指向**代理启动者**文件系统中的 ESM 模块。脚本在独立的 RunJS 沙箱中运行：

- 60 秒运行超时；无 network / eval 额外权限；文件访问和权限继承主代理的文件系统。
- 同一子代理的多次触发复用同一个持久化线程，**模块级变量在触发之间保留**，但线程会因为 10 分钟无触发被终止，因此，只靠模块变量保存状态是不可靠的。
- `process.env` 环境变量：

  | 变量 | 类型 | 含义 |
  |---|---|---|
  | `AGENT_ID` | number | 子代理 ID |
  | `AGENT_OWNER` | number | 子代理创建者 ID |
  | `AGENT_ERROR` | boolean | 本轮是否以错误结束 |
  | `AGENT_RESPONSE` | string | 子代理的回复内容，或者错误详情 |

- `"agents"` 宿主模块：

  ```js
  import { notifyAgent, retry } from "agents";

  // 直接发送原始消息，不会附加 XML 标签；id = 0 表示创建者
  await notifyAgent(1, "example"); // (id, content)

  // 把消息发回子代理自身并再运行一轮，实现 ReAct 循环等高级特性
  // 注意：retry 总是抛出 name="RetryError" 的特殊 Error
  if (retryCount < 10)
    await retry("格式不符合要求，再试一次");
  ```

- 使用文件系统或模块级变量保存重试次数，避免无限循环。
- 务必在 `AGENT_ERROR` 为 true 时中止循环并通知主代理，否则脚本会把错误吞掉。

# Agent 的自我修养

## 目标

将现有单一 LLM 工作流改写成可由主 agent 协调子 agent 执行的方案。

## 原则

- 经济性：不强行增加 agent；复杂度必须有回报。
   - 能用编程解决的事情，绝对不用子 agent 实现。
   - 如果多个子代理需要读取类似的文件，它们应该合成一个。
   - 只有委派能带来上下文隔离、并行效率、专业审查、重复批处理等收益时，才使用子 agent。
   - 最终方案是否比"全部交给一个 agent"更快/更省钱/更好效果。
- 并行性：派发互不依赖的并行任务。
   - 可选：用 ACL、ignore 避免子代理读写查到无关文件（如其他子代理的任务）
- 主体性：主 agent 始终保留全局目标、关键决策权、冲突处理和最终输出责任。
- 可验证性：结构化输出使用 JSON Schema 和 ValidateJson，而不是让子 agent 以文本形式回复 JSON；必要时基于代码的硬 Gate。
- 精确性：不写空泛建议，不使用"分析一下"这类模糊任务。子 agent 任务必须边界清晰、输入范围明确、输出格式明确、可独立验收。
- 安全性：复杂、高风险、影响面大或关键决策场景添加独立的 Review 子代理。

## 流程

1. 将每一步操作拆成原子步骤，但保留原方案目标、约束和意图；不要新增用户未要求的新目标。
2. 识别依赖：为每一步列出输入和输出。
3. 分析：
   - 需要定义目标、约束、优先级、输出最终判断或用户可见结论：主 agent。
   - 需要阅读大量材料，却只需要摘要或结构化结果：子 agent。
   - 并行派发互不依赖的子 agent。
   - 探索多个方案，可让多个子 agent 独立评估，再由主 agent 合并。