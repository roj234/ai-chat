import {registerTools} from "/src/skills.js";

// 预装插件
// 设置系统提示
import "./cmdSetPrompt.js";
// Blob ServiceWorker 缓存
import "./blobCache.js";
// 对话原始数据编辑
import "./conversationEditor.js";
// 无痕模式弹窗
import "./incognitoToast.js";
// Blob管理器
import "./managers/BlobManager.js";
// 搜索消息
import "./search.js";
// 连接测试插件，测试端点是否可用
import "./testConnection.js";
// 自动补全模型ID
import "./modelIdCompletion.js";
// 工具管理器
import "./managers/SkillManager.js";
// 自定义背景和字体
import "./customBackground.js";

// 预装工具
// 记忆工具
import "./tools/memories.js";
// 对话建议工具
import "./tools/followupSuggestions.js";
// 文件系统和Agent工具组 (use:workspace_files / run_process)
import "./tools/agent.js";
// 图表工具 (use:chart)
import "./tools/chart.js";
// 角色扮演工具组 (use:interactive_simulation)
import "./tools/rp_kit/interactive_simulation.js";
// 图片缩放工具 (use:zoom_in)
import "./tools/zoom_in.js";
// 代码解释器工具 (use:code_interpreter)
// 注意目前只能用JS，如果想用Python可以看看Pyoxide
import "./tools/interpreter.js";

// 内联代码的可选插件
import {registerTaskList} from "./tools/task_list.js";
import {registerFileTransfer} from "./tools/file_transfer.js";
import {registerJsonEditor} from "./tools/json_editor.js";
import {registerConfigSync} from "./configSync.js";
import {registerModelFastSwitch} from "./ModelFastSwitch.js";
import {registerMermaidRenderer} from "./mermaid.js";
import {registerMultimediaGeneration} from "./tools/multimedia_generation.js";

// 插件注册表
import {SETTINGS} from "/src/settings.js";
import {config, messages, selectedConversation} from "/src/states.js";
import "./PluginRegistry.css";
import morphdom from "morphdom";
import {registerCodeBlockRenderer, renderMarkdownToElement} from "/src/markdown/markdown.js";
import {createDragSort} from "/common/DragSort.js";
import {registerSchemaMessageRole} from "/common/ReactiveJSON.js";
import {COMMAND_REGISTRY} from "../src/commands.js";
import {registerHumanAsTool} from "./tools/human_as_tool.js";

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
		load: registerModelFastSwitch
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
		defaultEnabled: true,
		load: registerMultimediaGeneration
	},
	{
		name: "JSON编辑工具",
		description: "让LLM编辑JSON永远不出现语法错误（约束采样），以及基于JSON Pointer的增量修改工具\nJSON Schema Editor Web的替代品",
		load: registerJsonEditor
	},
	{
		name: "交互式文件上传/下载",
		description: "打包下载虚拟文件系统中的文件，或从文本框'上传'文件",
		load: registerFileTransfer
	},
	{
		name: "任务列表工具",
		description: "让模型能显示一个TODO清单给用户看",
		load: registerTaskList
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
		name: "读取时间工具",
		load: () => {
			registerTools("GetTime", "允许获取当前时间", [{
				name: "GetTime",
				description: "获取当前时间",
				script() {
					return new Date().toString();
				}
			}], {default: true});
		}
	},
	{
		name: "人在回路",
		description: "没想到我居然是LSP！",
		load: registerHumanAsTool
	},
	{
		name: "外部插件API",
		description: "暴露`window.AiChatAPI`对象用于注册工具 (非稳定API，可能随时修改)",
		load: () => {
			window.AiChatAPI = {
				registerTools,
				registerCodeBlockRenderer,
				registerSchemaMessageRole,
				registerCommand(name, desc, callback) {
					COMMAND_REGISTRY[name] = [callback, desc];
				},
				config,
				conversation: selectedConversation,
				messages
			};
		}
	},
];

if (DB_MODE !== "local") {
	pluginDefinitions.splice(2, 0, {
		name: "配置备份还原",
		description: "切换数据库服务器时备份当前配置",
		defaultEnabled: true,
		load: registerConfigSync
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
	const det =
		<div className="detail">
			<div className="detail-header">
				<h2>{plugin.name}</h2>
				{idx >= 0 ? <span className="status-badge enabled">已启用 (#{idx+1})</span> : <span className="status-badge">未启用</span>}
			</div>
			<div className="detail-meta">
				<div className="meta-item"><span className="label">版本</span> {plugin.version||"内置"}</div>
				<div className="meta-item"><span className="label">作者</span> {plugin.author||"Roj234"}</div>
				<div className="meta-item"><span className="label">主页</span> <a href={plugin.url} rel={"noreferrer noopener"}>{plugin.url}</a>
				</div>
			</div>
			{plugin.description && renderMarkdownToElement(<div className="md"/>, plugin.description)}
		</div>;

	morphdom(detailPanel, det);
};

const pluginManager = (
	<div className={"modal-overlay"}>
		<div className="modal plugin-manager">
			<div style={"display:flex;" +
				"overflow:hidden;" +
				"flex-direction:column"}>
				<div className="modal-header">
					插件管理
					<span className="badge">启用 {pluginOrder.length} / {pluginDefinitions.length} 插件</span>
					<span className={"spacer"}></span>
					<button className={"ri-close-line btn ghost"} onClick={() => pluginManager.remove(true)}></button>
				</div>

				<div className="interface">
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

					<main className="detail-panel">
						<div className="detail" ref={detailPanel}/>
					</main>
				</div>
			</div>
		</div>
	</div>
);

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
			document.body.append(pluginManager);
		}}>插件管理
		</button>
	</div>
});
