# 插件开发指南

AiChat 的插件系统基于模块导入，通过 `plugins/PluginRegistry.js` 注册。大部分功能（工具、角色扮演、UI 增强）都以插件形式实现。

首先，针对不想从源代码编译的用户，我提供了这个 API。  
这个 API 还可以用于调试 bug

```js
// 都有 JSDoc / TypeScript 类型定义
import {ContentPart, registerToolset} from "/src/toolset.js";
import {registerCodeBlockRenderer} from "/src/markdown/markdown.js";
import {registerSchemaMessageRole} from "/common/ReactiveJSON.js";

window.AiChatAPI = {
	registerTools: registerToolset,
	registerCodeBlockRenderer,
	registerSchemaMessageRole,
	registerCommand(name, desc, callback) {

	},
	ContentPart,
	config,
    markMessageDirty,
	conversation: selectedConversation,
	messages,
	conversations
};
```

registerTools 示例（有 MCP 你可能不太需要它）：

```js
const GetTime = {
	name: "GetTime",
	description: "Get current date, time and timezone",
	script: () => new Date().toString()
};

registerToolset("GetTime", "获取当前时间", [GetTime], {
	hidden: "manual"
});
```

registerCodeBlockRenderer 示例
```js

registerCodeBlockRenderer("mermaid", (code, language, node, is_finished) => {
	// 加载 mermaid.js

    // 返回 true 允许增量更新文本（如果渲染器要等代码块关闭才能执行）
	if (!is_finished) return true;

	// 如果会导致节点的 textContent 变化，需要把文本保存到这处理复制按钮的行为
	node.dataset.text = code;

	// 然后就是任意代码了，node 是 DOM 节点
	renderQueue = renderQueue.then(() => {
		if (node.isConnected) {
			delete node.dataset.processed;
			mermaid.run({ nodes: [node] });
			node.className = "mermaid";
		}
	});
});
```

registerSchemaMessageRole 示例  
我不建议单纯通过 window 上的 API 来调用它，因为它对 Unconscious 的依赖相当多  
[使用方法](./ReactiveJSON.md)

3.7.0新增：
修改消息内容后必须调用 markMessageDirty(message) 否则不会保存到数据库！！！

## 后端插件
后端插件相对宽松，只需要遵循特定的目录格式 （./plugins/folder/index.js） 并在 index 中导出默认函数就会自动加载。  
这个函数会接受一个 Router 实例作为参数，可以自行注册路由。  
有关类型定义在 backend/types.d.ts 中
后端插件在项目 backend/plugins 里有两个实例可以参考。