# 插件开发指南

AiChat 的插件系统基于模块导入，通过 `plugins/PluginRegistry.js` 注册。大部分功能（工具、角色扮演、UI 增强）都以插件形式实现。

## 插件注册

### 入口文件

`plugins/PluginRegistry.js` 是插件的中央注册表。所有插件通过 `import` 语句加载：
- 大部分工具甚至包括角色扮演支持都可以异步导入
- 如果你想，完全可以通过其中的 Promise 回调来实现按需加载（动态启用/禁用插件）

```js
// plugins/PluginRegistry.js
import "./tools/your-tool.js";
import "./your-plugin.js";
```

### 插件生命周期

插件在导入时自动执行初始化逻辑。使用 `onLoad` 钩子可以延迟执行到框架就绪：  
插入配置项直接使用 `SETTINGS.push(...)` 可以填什么我还没有文档，  
你可以参考 `settings.js` 或者直接看 `unconscious/common/components/Filter.jsx` 的表单构造器  
另外一个可能比较重要的函数是 `createTab` 创建新配置标签页在 `SettingDialog.jsx` 里面

```js
import { onLoad } from "/src/plugin.js";

onLoad(() => {
  // 在此处执行初始化，此时框架已就绪
  console.log("插件已加载");
});
```

## 开发工具

### 工具注册

下面提到的所有函数都有 JSDoc 和 TypeScript 类型定义，你可以自行查看  
工具通过 `src/skills.js` 中的注册表定义：

```js
import { registerDefaultTools } from "/src/skills.js";

// 注册默认工具（始终可用）
registerDefaultTools([{
  name: "tool_name",
  description: "工具描述",
  parameters: { /* JSON Schema */ },
  script(params, response) {
    // 工具执行逻辑
    return "执行结果";
  }
}]);
```

### 可选工具组（技能/Skills）

对于需要手动激活的工具组，使用可选工具注册：

```js
import { registerTools } from "/src/skills.js";

registerTools(
	"my-tools",
	"我的工具组",
	[tool_a],
    {
        hidden: false,
        systemPrompt: "使用这些工具的提示词",
    }
);
```

模型可以看到不隐藏的工具组的description，并按需自主激活它们。  
隐藏的工具只能通过 `/use_tools my-tools` 激活，通过 `/revoke_tools my-tools` 禁用。  

### 返回复杂内容

使用 `ContentPart` 类返回多部分内容：

```js
import { ContentPart } from "/src/skills.js";

const tool_a = {
  script(params, response) {
    const result = new ContentPart().text("这是一段文字"); // 支持链式调用
    result.image("data:image/png;base64,..."); // 也可以传入 blob
    return result;
  }
};
```

目前只支持文字和图片

### 自定义 UI 渲染

工具可以标记为"需要用户交互"并提供渲染函数以显示UI：
> 详见TS类型定义

```js
const interactive_game = {
	interactive: true,
	script(params, response) {
		// 可以（但不是必须）什么都不做
	},
	// context 包含工具调用的上下文信息
	renderer(context) {
		return <div><button>选项A</button><button>选项B</button></div>;
	}
};
```

## 注册斜杠命令

```js
import { COMMAND_REGISTRY } from "/src/commands.js";

COMMAND_REGISTRY['my_command'] = [
	(args, params, element) => {
		// 命令执行逻辑
		return "命令执行结果";
	},
	"命令描述"
];
```

## 插件示例

### 完整工具插件

```js
// plugins/tools/my-tool.js
import { registerDefaultTools } from "/src/skills.js";

registerDefaultTools([{
  name: "get_weather",
  description: "获取指定城市的天气",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "城市名称" }
    },
    required: ["city"]
  },
  async script({ city }) {
    const response = await fetch(`https://api.weather.example/${city}`);
    return response.text();
  }
}]);
```

### 命令插件

```js
// plugins/cmdExport.js
import { COMMAND_REGISTRY } from "/src/commands.js";

COMMAND_REGISTRY.hello = [
	() => "Hello from plugin!",
	"输出问候语"
];
```

## 后端插件

后端也有插件系统，插件放在 `backend/plugins/` 目录下自动加载。后端插件具有完整的文件系统访问权限，可以注册 API 路由、中间件等。

```js
// backend/plugins/my-plugin/index.js
export function init(router, app) {
  router.get("/my-plugin/status", (ctx) => {
    return "ok";
  });
}
```

## 你可以参考的代码

```
plugins/
├── PluginRegistry.js        # 中央注册表
├── tools/                   # 工具插件
│   ├── filesystem.js        # 文件系统工具 (use:fs)
│   ├── ChartCreator.js      # 图表工具 (use:chart)
│   ├── roleplay.js          # 角色扮演 (工具组)
│   ├── zoom.js              # 图片缩放 (use:zoom)
│   ├── txt2any.js           # 文生图/TTS (异步工具)
│   ├── memory.js            # 记忆工具 (提示词的应用)
├── rpg/                     # RPG 管线
├── mermaid.js               # Mermaid 渲染 (注册自定义代码块渲染器)
└── search.js                # 消息搜索 (复杂交互)
```
