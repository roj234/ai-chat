
# 教程：构建响应式流式 JSON 界面

当你使用 LLM 生成结构化 JSON 时，通常需要等待整个字符串接收完毕才能解析。**ReactiveJSON** 允许你在 JSON 还在传输时，就实时地将已解析的部分渲染到页面上。

本教程将教你如何实现类似 `galgame_example.js` 的效果。

## 1. 核心概念

*   **`createReactiveJSON()`**: 创建一个特殊的响应式代理对象。当你往里面灌入不完整的 JSON 字符串时，它会自动解析并更新对应的属性。
*   **`createReactiveMarkdown(container, value)`**: 专门用于处理 JSON 字段中的 Markdown 文本，实现流式打字机效果。
*   **`$foreach(list, callback)`**: 监听数组变化，实时增量渲染列表项，其功能相当于响应式的 list.map(callback) 。

## 2. 准备工作

首先，你需要定义你的 **JSON Schema**。这是 LLM 遵循的规范，也是你 UI 结构的蓝图。

```javascript
const schema = {
    type: "object",
    properties: {
        character: { type: "string" },
        dialogue: { type: "string" },
        inventory: { 
            type: "array", 
            items: { type: "string" } 
        }
    }
};
```

## 3. 实现步骤

### 第一步：调用模型

```javascript
await jsonPrompt(
	[], // 在这里填入OpenAI兼容消息
    {
		// 必填项目，galgame的名字可以随便填，好像没人检查这个
        // 请注意：务必在OpenAI兼容消息数组中告诉模型要怎么写JSON，这里只是格式约束，模型看不到它！
        // 已经启用严格约束，模型无法生成错误的JSON （除非API不支持）
        ...schemaWrapper("galgame", schema),
        
        // 你可以填写其它参数，例如 temperature 等
        reasoning: { enabled: false },
        max_tokens: 8000,
    },
    'my_plugin/custom_type' // 这里要和下面 registerReactiveCodeBlockRenderer 中的相同
);
```

### 第二步：构建 DOM 结构

利用 `unconscious` 提供的响应式能力，将 `data` 绑定到 HTML 元素上。

```javascript
const renderUI = (data) => (
    <div class="npc-card">
        {/* 1. 简单文本绑定 */}
        <h2 class="name">
            {() => unconscious(data.character) || "加载中..."}
        </h2>

        {/* 2. 流式 Markdown 绑定 (用于长文本) */}
        {createReactiveMarkdown(<div class="content" />, data.dialogue)}

        {/* 3. 列表循环绑定 */}
        <div class="items">
            {$foreach(data.inventory, (item) => (
                <span class="tag">{item}</span>
            ))}
        </div>
    </div>
);
```

### 第三步：接入流式数据

你需要将 LLM 返回的增量文本实时传给 `update` 函数。如果你在编写 Markdown 代码块渲染器，通常如下操作：

```javascript
// 请注意 my_custom_type 必须和 jsonPrompt 中填写的相同，并且全局唯一
// 另外ID中不能出现英文冒号 ':' 你可以使用斜杠作为命名空间分隔符
registerSchemaCodeBlockRenderer('my_plugin/custom_type', renderUI);
```

## 4. 关键技巧与陷阱

### A. 访问原始值
在 JS 表达式或属性判断中，使用 `unconscious(proxy)` 来获取其当前解析到的原始值。
```javascript
// 错误写法：if (data.location) ... (proxy对象永远为真)
// 正确写法：
<div style={() => unconscious(data.location) ? "" : "display:none"}>
```

### B. 处理特殊的 `value` 属性
在流式 JSON 中，如果你的 JSON key 恰好叫 `value`，由于它是响应式内部关键字，请在 UI 绑定时改用 `$value` 访问。
```javascript
// JSON: { "name": "HP", "value": 100 }
<span>{item.name}: {item.$value}</span> 
```

### C. Markdown 的流式渲染
普通的文本绑定如 `data.text` 会在每次字符更新时重绘整个容器。使用 `createReactiveMarkdown` 可以实现只追加新字符，性能更好且不会中断 CSS 动画。

### D. 样式与动画
由于 DOM 节点是增量产生的，你可以利用 CSS 动画为新产生的元素添加淡入效果：
```css
/* gal.css */
.gal-card {
    animation: fadeIn 0.5s ease-out;
}
@keyframes fadeIn {
    from { opacity: 0; transform: translateY(10px); }
    to { opacity: 1; transform: translateY(0); }
}
```

## 5. 完整代码结构参考

你可以参考 `galgame_example.js` 的模式：
1. **定义 Schema**: 确保 LLM 输出可预测。
2. **注册渲染器**: 挂载到 Markdown 解析流程。
3. **数据占位**: 在数据未到达时显示“--”或加载中。
4. **状态隔离**: 使用 `debugSymbol` 或私有属性将 `rjson` 实例绑定在当前 DOM 节点上，防止重复渲染。

---

通过这种方式，你可以构建出极其流畅的 AI 交互体验，用户不再需要盯着空白屏幕等待回复结束，或者对着 JSON 语法高亮发呆，而是看着内容像“生长”一样出现在界面上。