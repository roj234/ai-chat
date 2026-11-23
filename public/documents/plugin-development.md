# 插件开发指南

AiChat 的插件系统基于模块导入，通过 `plugins/PluginRegistry.js` 注册。大部分功能（工具、角色扮演、UI 增强）都以插件形式实现。

针对不想编译的用户，我提供了 `window.Aint` 接口。尽管它主要用途是在 production 版本上定位 bug

```js
// pluginApi.js
window.Aint = Object.freeze({
	spec: 261125,
    // 一个随便放什么的容器
	plugins: Object.create(null),

	// 暴露内部状态用于调试
	config,
	conversation: selectedConversation,
	messages,
	conversations,
	currentCombinedConfig,
	toolScriptRegistry,

	// 注册代码块渲染器
	registerCodeBlockRenderer,
	// 注册 schema 消息角色
	registerSchemaMessageRole,

	// 注册自定义工具
	registerToolset,
	markMessageDirty,
	ContentPart,
	EVENT_BUS,
	JS_HOST_MODULES,
	JS_SANDBOX_MODULES,

	registerCommand(name, desc, callback) {
		COMMAND_REGISTRY[name] = [callback, desc];
	},
});
```

registerTools 示例（可以注册自定义渲染的工具）：

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
后端插件在项目 backend/plugins 里有几个实例可以参考。