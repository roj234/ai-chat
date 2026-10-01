import {ContentPart, registerToolset} from "/src/toolset.js";

// 预装插件
// 记住输入框
import "./persistInputBox.js";
// Blob ServiceWorker 缓存
import "./blobCache.js";
// 对话原始数据编辑
import "./conversationEditor.js";
// Blob管理器
import "./managers/BlobManager.js";
// 搜索消息
import "./search.js";
// 连接测试插件，测试端点是否可用
import "./testConnection.js";
// 自动补全模型ID
import "./modelIdCompletion.js";
// 工具管理器
import "./managers/ToolManager.js";
// 自定义背景和字体
import "./customBackground.js";

// AGENTS.md 支持
import "./agent/agents-md.js";
// 文件系统、命令和代码执行
import "./agent/files.js";
// 技能
import "./agent/skills.js";

// 预装工具
// JSON编辑
import "./tools/json_editor.js";
// 上下文压缩
import "./tools/subjective_context_compression.js";
// 任务列表
import "./tools/task_list.js";
// 子代理
import "./tools/subagent.js";
// 记忆
import "./tools/memories.js";
// 对话建议
import "./tools/followupSuggestions.js";
// 图表
import "./tools/chart.js";
// 角色扮演工具
import "./rp_kit/interactive_simulation.js";
// 预装管线（？）
import "./rpg/example/Translator.js";

// 内联代码的可选插件
import {registerConfigSync} from "./configSync.js";
import {registerPresetFastSwitch} from "./PresetFastSwitch.js";
import {registerMermaidRenderer} from "./mermaid.js";
import {registerMultimediaGeneration} from "./tools/multimedia_generation.js";
import {registerRemoteControl} from "./remoteControl.js";

// 插件注册表
import {SETTINGS} from "/src/settings.js";
import {config, conversations, messages, selectedConversation} from "/src/states.js";
import "./PluginRegistry.css";
import morphdom from "morphdom";
import {registerCodeBlockRenderer, renderMarkdownToElement} from "/src/markdown/markdown.js";
import {createDragSort} from "/common/DragSort.js";
import {registerSchemaMessageRole} from "/common/ReactiveJSON.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {GetTime} from "./rp_kit/interactive_simulation.js";
import {markMessageDirty} from "/src/database.js";
import {openWindow} from "../src/components/Windows.jsx";

// 时间工具
registerToolset("GetTime", "获取时间", [GetTime], {
	default: true,
	hidden: "manual"
});

// 插件API
window.AiChatAPI = {
	registerTools: registerToolset,
	registerCodeBlockRenderer,
	registerSchemaMessageRole,
	registerCommand(name, desc, callback) {
		COMMAND_REGISTRY[name] = [callback, desc];
	},
	markMessageDirty,
	ContentPart,
	config,
	conversation: selectedConversation,
	messages,
	conversations
};

/**
 * @type {Array<{
 *     name: string,
 *     description?: string,
 *     author?: string,
 *     version?: string,
 *     url?: string,
 *     defaultEnabled?: boolean,
 *     load: (function(): Promise<*>)
 * }>}
 */
const pluginDefinitions = [
	{
		name: "预设快速切换菜单",
		description: "在输入框左侧添加一个预设切换菜单",
		defaultEnabled: true,
		load: registerPresetFastSwitch
	},
	{
		name: "基础角色扮演",
		description: "实现角色卡、世界书、预设等数据结构的导入和导出支持，以及请求体的构造，提供基础角色扮演能力",
		defaultEnabled: true,
		load: () => import("./rp_basic/BasicRoleplay.js")
	},
	{
		name: "Mermaid流程图",
		description: "提供Mermaid流程图的渲染能力",
		defaultEnabled: true,
		// 2. 修改默认的系统提示词避免LLM继续使用mermaid
		load: registerMermaidRenderer
	},
	{
		name: "多媒体资源生成工具",
		description: "提供ComfyUI/SD WebUI文生图工具，以及TTS工具（后者WIP）",
		load: registerMultimediaGeneration
	},
	{
		name: "Llama.cpp扩展",
		description: "通过GUI加载和卸载路由模式的模型，另提供Token计数功能",
		load: () => import("./llamaCpp.js")
	},
	{
		name: "RPG管线Lite",
		description: "使用 `/say <text>` 命令测试结构化故事，我认为这是AIRP的未来。",
		load: () => import("./rpg/example/StoryTurn.js")
	},
	{
		name: "远程控制",
		description: "需要两端都启用，并且被控端设为无人值守模式。",
		defaultEnabled: true,
		load: registerRemoteControl
	},
	{
		name: "耗时分析",
		description: "使用 `/actime` 命令查看当前对话的分析",
		defaultEnabled: true,
		load: () => import("./actime/actime.js")
	},
	{
		name: "微信机器人 (WIP)",
		description: "开发中",
		load: () => import("./chatbot/chatbot.js")
	},
];

if (DB_MODE !== "local") {
	pluginDefinitions.splice(2, 0, {
		name: "配置备份还原",
		description: "切换数据库服务器时备份当前配置",
		defaultEnabled: true,
		load: registerConfigSync
	});
	pluginDefinitions.push({
		name: "私信 (WIP)",
		description: "与其他用户聊天，使用 /dm <user> 打开界面，需要服务器支持",
		load: () => import("./DM.js")
	});
}

const pluginOrder = (config.pluginOrder?.map(i => pluginDefinitions[i])  || pluginDefinitions.map(item => item.defaultEnabled&&item)).filter(Boolean);

const orderedItems = new Set(pluginOrder);
pluginDefinitions.forEach((def, idx) => {
	def.id = idx;
	orderedItems.add(def);
});

const pluginIndexMap = new Map(
	pluginOrder.map((def, idx) => [def, idx])
);

export const onPluginLoaded = Promise.all(pluginOrder.map(i => i.load()));

let pluginListContainer;
let detailPanel;

const updatePluginSet = () => {
	config.pluginOrder = [...pluginListContainer.childNodes].map(el => el.querySelector(".switch").checked && el._key).filter(Boolean).map(i => i.id);
}

const setDetails = (plugin, self) => {
	pluginListContainer.querySelector(".active")?.classList.remove("active");
	self.classList.add("active");

	const idx = pluginOrder.indexOf(plugin);
	const det = <main className="detail">
		<div className="detail-header">
			<h2>{plugin.name}</h2>
			{idx >= 0 ? <span className="status-badge enabled">已启用 (#{idx+1})</span> : <span className="status-badge">未启用</span>}
		</div>
		<div className="detail-meta">
			<div className="meta-item"><span className="label">版本</span> {plugin.version||"内置"}</div>
			<div className="meta-item"><span className="label">作者</span> {plugin.author||"Roj234"}</div>
			<div className="meta-item"><span className="label">主页</span> <a href={plugin.url} rel={"noreferrer noopener"}>{plugin.url}</a></div>
		</div>
		{plugin.description && renderMarkdownToElement(<div className="md"/>, plugin.description)}
	</main>;

	morphdom(detailPanel, det);
};

const pluginManager = (<>
	<aside className="msidebar" ref={pluginListContainer}>
		{[...orderedItems].map((item) => {
			const el = <div className="item" onClick={(e) => setDetails(item, el)} _key={item}>
				<span className="drag-handle" title="调整加载顺序">⠿</span>
				<span className="plugin-info">
					<b className="plugin-name ellipsis">{item.name}</b>
					<span className="plugin-author ellipsis">{item.author || 'Roj234'}</span>
				</span>
				<input type={"checkbox"} className="switch" onClick.stop={updatePluginSet} checked={pluginIndexMap.has(item)}/>
			</div>;
			return el;
		})}
	</aside>
	<main className="detail" ref={detailPanel}/>
</>);

createDragSort(pluginListContainer, {
	itemSelector: ".item",
	handleSelector: ".drag-handle",
	onMovedTo: updatePluginSet
});

SETTINGS.push({
	id: "pluginOrder",
	type: "element",
	element: <div className={"choice-scroll"}>
		<button className={"btn ghost"} onClick={() => {
			openWindow({
				id: "plugin-manager",
				title: "插件管理器",
				actions: <span className="pm-badge">启用 {pluginOrder.length} / {pluginDefinitions.length} 插件</span>,
				element: pluginManager,
				width: 768,
				height: 600,
				reuse: true
			});
		}}>插件管理
		</button>
	</div>
});
