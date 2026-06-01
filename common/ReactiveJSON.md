# 教程：构建响应式流式 JSON 界面

当你使用 LLM 生成结构化 JSON 时，通常需要等待整个字符串接收完毕才能解析。**ReactiveJSON** 允许你在 JSON 还在传输时，就实时地将已解析的部分渲染到页面上。

本教程将基于 `StoryEngine.js` 的实现，教你如何构建一个支持流式渲染的 AI 互动界面。

## 1. 核心概念

*   **`$foreach(list, callback)`**  
    响应式列表渲染。当数组新增元素时，自动增量挂载新 DOM，而不是重新渲染整个列表。  
    作用类似 `list.map(callback)`，但性能更好且不会打断已有动画。

*   **`$once(source, callback)`**  
    仅当数据 **第一次变得可用**（如从 `undefined` 变为非空）时挂载一个元素，之后不再更新（元素内容将会更新）。  
    非常适合渲染“手动思维链”这类可能不存在的内容。

*   **`registerSchemaMessageRole(id, name, renderer, composer?, schema?)`**  
    注册一个自定义消息类型的渲染器。`id` 需与 `jsonPrompt` 中使用的类型 ID 一致（如 `'my/storyEngine'`）。  
    它替代了旧版教程中的 `registerSchemaCodeBlockRenderer`。

*   **`createReactiveMarkdown(container, value)`**  
    专门用于处理 JSON 字段中的 Markdown 文本，实现流式打字机效果。

*   **`unconscious(value)`**  
    获取响应式属性的非响应式原始数据。

## 2. 准备工作

定义你的 **JSON Schema**，这既是 LLM 输出的约束，也是 UI 结构的蓝图。

```javascript
const schema = {
    type: "object",
    properties: {
        reasoning: { type: "string" },            // 可选：思考过程
        character: { type: "string" },
        dialogue: { type: "string" },
        inventory: {
            type: "array",
            items: { type: "string" }
        },
        suggested_choices: {                      // 可选交互选项
            type: "array",
            items: { type: "string" }
        }
    },
    required: ["character", "dialogue"]
};
```

## 3. 实现步骤

### 第一步：调用模型 （WIP，未来可能改变）

使用 `jsonPrompt` 发起请求，指定类型 ID 和 Schema 约束。

```javascript
import {$update, unconscious} from "unconscious";
import {messages} from "/src/states.js";
import {schemaToPrompt} from "/common/schemaToTypeDef.js";
import {jsonPrompt} from "/plugins/rpg/core.js";

const ID = 'my/storyEngine';

async function sendAction(messages, userInput) {
	// 你可以根据用户消息修改schema，如果需要
	const schema_ = structuredClone(schema);

	// 构造用户提示
	const time = Date.now();
	messages.push({
		id: -1, // 不存入数据库
		role: "user",
		time,
		content: schemaToPrompt(schema, config.jsonSupport) + "提示词，当然，你也可以不用schemaToPrompt函数，手动向AI描述schema\n" + userInput
	});

	const originalPrompt = {
		role: "user",
		time,
		content: userInput
	};

	let assistantResponse;
	try {
		// 调用模型
		assistantResponse = await jsonPrompt(schema_, messages, {
			// 自定义请求体
			reasoning: {enabled: enableThink},
			max_tokens: 8000,
		}, ID);
	} catch (e) {
		console.error(e);
		// 出错了，恢复原始数据
		messages[messages.length - 2] = originalPrompt;
		return;
	}

	// 将 AI 回复替换消息数组，使用splice是为了兼容对话分支
	messages.splice(messages.length - 2, 2,
		originalPrompt,
		{
			...assistantResponse,
			role: ID,
			content: JSON.parse(assistantResponse.content)
		}
	);
}
```

### 第二步：构建响应式 UI

渲染函数接收的是一个 **已解析的响应式代理对象**（即 `content` 字段）。  
利用 `$foreach`、`$once` 和 lambda 表达式等实现增量渲染。

```javascript
import {$foreach} from "unconscious";
import {$once, createReactiveMarkdown, registerSchemaMessageRole} from "/common/ReactiveJSON.js";
import "./myStyle.css"; // 加载样式！

function renderStory(val) {
    return [
        // 基础文本：用箭头函数避免直接读取代理
        <header>
            👤 {() => unconscious(val.character) || "加载中..."}
        </header>,

        // 仅显示一次的“思考过程”
        $once(val.reasoning, () => (
            <div class="reasoning">{val.reasoning}</div>
        )),

        // 流式 Markdown（自动打字机效果）
        {createReactiveMarkdown(<div class="dialogue"/>, val.dialogue)},

        // 响应式列表：每新增一个物品就挂载一个节点
        <div class="items">
            {$foreach(val.inventory, (item) => (
                <span class="tag">{item}</span>
            ))}
        </div>,

        // 条件渲染的按钮，仅在有选项时挂载（避免无故出现 margin，padding，background 等）
        $once(val.suggested_choices, () => (
            <div class="choices" onClick.delegate={"button"}={({delegateTarget}) => {
                sendAction(messages, delegateTarget.textContent);
            }}>
                {$foreach(val.suggested_choices, (choice) => (
                    <button>{choice}</button>
                ))}
            </div>
        ))
    ];
}
```

### 第三步：注册渲染器

用 `registerSchemaMessageRole` 挂载你的 UI 渲染函数。

```javascript
import {COMMAND_REGISTRY} from "/src/commands.js";
import {registerSchemaMessageRole} from "/common/ReactiveJSON.js";

const composer = ({content}, output, input, index, length) => {
	// 可以进行更复杂的判断决定给 LLM 看哪些文字
	output.push({
		role: "assistant",
		content: JSON.stringify(content)
	});
};

registerSchemaMessageRole(
    ID,            // 必须与 jsonPrompt 的参数一致
    '故事渲染器',   // 显示名称
    renderStory,   // 渲染函数 (val) => JSX.Element[]
    composer,      // 消息组合函数，用于决定哪些数据要发回LLM
    schema         // 可选的 schema （可以和AI生成的不同，例如少些 required，或包含复杂的 allOf ），用于编辑时的校验
);

// 注册命令
COMMAND_REGISTRY["say"] = [
	(args) => {
		sendAction(messages, args[0].trim());
	},
	"开启或继续一段富文本故事"
];
```

## 4. 关键技巧与陷阱

### A. 用 `unconscious` 获取原始值
渲染器中拿到的 `val` 是响应式代理，不能直接用于条件判断，必须用 `unconscious(val)` 取出当前值。

```javascript
// ❌ 错误：代理对象始终为真，元素永远不会隐藏
<div style={val.location ? "" : "display:none"}>

// ✅ 正确
<div style={() => unconscious(val.location) ? "" : "display:none"}>
```

### B. 处理特殊的 `value` 属性
如果你的 Schema 中某个字段恰好叫 `value`（响应式内部关键字），渲染时需通过 `unconscious(item).value` 间接访问。

```javascript
// JSON: { "name": "HP", "value": 100 }
<span>{item.name}: {() => unconscious(item).value}</span>
```

### C. `$foreach` 与 `$once` 的作用边界
- **`$foreach`** 适用于数组，会持续监听新增与删除，适合不确定长度的列表。
- **`$once`** 适用于只显示一次的数据（如推理过程、生成成功标志），一旦挂载就不再销毁或更新。

如果某个字段是可变的且需要实时反映变化，直接用 `{val.text}` 绑定即可。

### D. 样式与动画
由于 DOM 节点是增量产生的，你可以利用 CSS 为新元素添加淡入效果：

```css
.card {
    animation: fadeIn 0.4s ease-out;
}
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: translateY(0); }
}
```

## 5. 完整代码结构参考

你可以参考 `StoryEngine.js` 的组织方式：

1. **定义 Schema**：确保 LLM 输出既符合业务需要，又能被 UI 安全渲染。
2. **注册渲染器**：使用 `registerSchemaMessageRole`，将角色 ID 与 UI 函数绑定。
3. **调用模型**：`jsonPrompt` 发起请求，解析结果后 push 到响应式消息数组。
4. **增量渲染**：用 `$foreach` 处理列表，`$once` 处理一次性内容，`createReactiveMarkdown` 处理长文本。
5. **交互封闭**：在 `$once` 或 `$foreach` 内部通过事件委托绑定用户操作，触发新一轮的 `sendAction`。

通过这套模式，你就能够构建出那种“文字像生长一样出现在屏幕上”的高沉浸感 AI 应用，而且无需面对 JSON 解析的复杂性或等待整段回复完成。