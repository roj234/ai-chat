import SimpleModal from "/src/components/SimpleModal.jsx";
import {highlightJsonLike} from "/src/markdown/highlight.js";
import {$computed, $state, $update, $watch, $watchWithCleanup, unconscious} from "unconscious";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {addMCPServer, defaultGroups, toolScriptRegistry, toolset} from "/src/skills.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";

import "./SkillManager.css";
import "../rp_basic/PresetPanel.css";
import {config, ensureActiveConversation, selectedConversation} from "/src/states.js";
import {CUSTOM_CONTROLS, SETTINGS} from "/src/settings.js";
import {Filter} from "unconscious/common/components/Filter.jsx";

import {createPanel} from "../rp_basic/CreatePanel.jsx";
import {onLoad} from "../../src/plugin.js";

SETTINGS.push({
	id: "mcps",
	type: "element",
	_tab: "tools",
	element: <div className={"choice-scroll"}>
		<button className="btn ghost" onClick={() => skillManagerPanel.open()} disabled={() => !unconscious(selectedConversation)}>工具管理</button>
	</div>
});

let mcpServers = [];

const refreshTools = $computed(() => !!selectedConversation.ready);
const currentTools = $computed(() => {
	return Object.entries(toolset).filter(([k, v]) => v.hidden !== true).map(([k, v]) => ({
		name: k,
		...v
	}));
}, [refreshTools]);

onLoad(() => {
	$watch($computed(() => config.mcps), () => {
		const mcps = config.mcps;
		mcpServers && mcpServers.forEach(close => close());
		mcpServers = mcps && mcps.map(({url, name, desc, ...rest}) => addMCPServer(url, name, desc, rest));
		$update(refreshTools);
	});

	addEventListener("beforeunload", () => {
		mcpServers && mcpServers.forEach(close => close());
	});
});

/**
 *
 * @return {[import("unconscious").Renderable, VirtualList]}
 */
function createList() {
	const list = <ul onClick.delegate{"input[type=checkbox]"}={async ({delegateTarget}) => {
		const key = delegateTarget.closest("li").dataset.name;

		await ensureActiveConversation();
		const conv = unconscious(selectedConversation);
		const Use = toolScriptRegistry['Use'];
		if (delegateTarget.checked) {
			Use.script({modules: [key]}, {}, conv);
		} else {
			if (!conv.activatedModules) Use.script({modules: []}, {}, conv);
			Use.undo({newModules: [key]}, conv);
		}
	}} />;

	const virtualList = new VirtualList({
		element: list,
		itemHeight: 88,
		renderer(mod) {
			const desc = mod.uiDesc || mod.description;
			return <li data-name={mod.name}>
				<div className={"summary"}>
					<span className="name">{mod.name}</span>
					{mod.hidden && <small title={"需要人工操作"}>手动</small>}
					{mod.allowedTools?.length && <small title={mod.allowedTools.join("\n")}>{mod.allowedTools.length} 个工具</small>}
					{mod.data === "MCP" && <button
						className="preset-panel__delete-btn"
						onClick={() => {
							const idx = config.mcps.findIndex(mcp => mcp.name === mod.name);

							SimpleModal({
								title: "确认删除",
								message: <div dangerouslySetInnerHTML={highlightJsonLike(config.mcps[idx])}/>,
								accent: 'danger',
								onConfirm() {
									config.mcps.splice(idx, 1);
									$update(config);

									const vlIdx = virtualList.findIndex(mod);
									virtualList.items.splice(vlIdx, 1);
									virtualList.setItems(virtualList.items);
								}
							})
						}}
						title="删除"
					>
						<i className="ri-delete-bin-line"></i>
					</button>}
					<input
						className="switch"
						type="checkbox"
						checked={(selectedConversation.activatedModules || defaultGroups).has(mod.name)}
					/>
				</div>
				{desc && renderMarkdownToElement(<div className={"md"}/>, desc)}
			</li>;
		},
		keyFunc(item) {
			return item.name+'/'+((selectedConversation.activatedModules || defaultGroups).has(item.name)?1:0);
		}
	});

	return [list, virtualList];
}


function openSkillManager(preset, isOpen, close) {
	const [el, vl] = createList();

	$watchWithCleanup(currentTools, () => {
		console.log("updated");
		vl.setItems(unconscious(currentTools));
	});

	return (
		<div className={`preset-panel skill-manager`} class:open={() => isOpen.value}>
			<div className="header">
				<h2 className="title">工具和技能配置</h2>
				<div style={"display:flex;gap:0.5rem"}>
					<button className="ri-add-line btn ghost" title={"添加MCP服务器"} onClick={() => {
						const state = $state({});
						const filter = <Filter config={[
							{
								type: "input",
								name: "名称",
								placeholder: "建议 PascalCase",
								id: "name",
								pattern(name) {
									if (!/^[a-zA-Z0-9_-]+$/.test(name)) return "名称只能包含大小写字母数字斜杠下划线";
									if (config.mcps.find(mcp => mcp.name === name)) return "名称与现有MCP/工具集重复";
									return [name];
								},
								required: true
							},
							{
								type: "radio",
								id: "prefix",
								required: true,
								name: "命名空间",
								choices: {
									"无": null,
									"前缀": true
								},
								title: {
									"前缀": "在MCP工具名称前添加MCP服务器名称"
								}
							},
							{
								type: "input",
								name: "服务器地址",
								placeholder: "支持 SSE 和 Streamable HTTP 传输协议",
								id: "url",
								pattern: /.+/,
								required: true
							},
							{
								type: "input",
								name: "API密钥",
								placeholder: "sk-xxxxxx",
								id: "key",
							},
							{
								type: "input",
								name: "简介",
								placeholder: "Online search",
								id: "desc"
							},
							{
								type: "radio",
								id: "hidden",
								required: true,
								name: "模型自主激活 (请填写简介)",
								choices: {
									"拒绝": 'manual',
									"允许": null
								},
							}
						]} choices={state}/>;
						const modal = SimpleModal({
							title: "添加MCP服务器",
							message: filter,
							onConfirm() {
								const obj = unconscious(state);
								for (const key in obj) {
									if (!obj[key]) delete obj[key];
								}
								config.mcps = [ ...(config.mcps || []), obj];
							}
						});

						$watch(state, () => {
							modal.querySelector(".btn.primary").disabled = !!filter.hasError();
						})
					}}>
					</button>
					<button className="ri-sidebar-unfold-fill btn ghost" title={"关闭编辑面板"}
							onClick={close}></button>
				</div>
			</div>
			{el}
		</div>
	);
}

const skillManagerPanel = createPanel(openSkillManager);
CUSTOM_CONTROLS.find(el => el.matches(".ri-robot-2-line")).addEventListener("contextmenu", (e) => {
	e.preventDefault();
	skillManagerPanel.open();
});