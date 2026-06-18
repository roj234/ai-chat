import SimpleModal from "/src/components/SimpleModal.jsx";
import {highlightJsonLike} from "/src/markdown/highlight.js";
import {$computed, $state, $update, $watch, $watchWithCleanup, unconscious} from "unconscious";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {addMCPServer, defaultGroups, toolGroups, toolScriptRegistry} from "/src/skills.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";

import "./SkillManager.css";
import {config, selectedConversation} from "/src/states.js";
import {CUSTOM_CONTROLS, SETTINGS} from "/src/settings.js";
import {Filter} from "unconscious/common/components/Filter.jsx";

import {createPanel} from "../rp_basic/CreatePanel.jsx";

SETTINGS.push({
	id: "mcps",
	type: "element",
	_tab: "tools",
	element: <div className={"choice-scroll"}>
		<button className="btn ghost" onClick={() => skillManagerPanel.open()} disabled={() => !unconscious(selectedConversation)}>工具管理</button>
	</div>
});

let mcpServers = [];

$watch($computed(() => config.mcps), () => {
	const mcps = config.mcps;
	mcpServers && mcpServers.forEach(close => close());
	mcpServers = mcps && mcps.map(item => addMCPServer(item.url, item.name, item.desc, {headers:item.headers}));
})

/**
 *
 * @return {[import("unconscious").Renderable, VirtualList]}
 */
function createList() {
	const list = <ul onClick.delegate{"input[type=checkbox]"}={({delegateTarget}) => {
		const key = delegateTarget.closest("li").dataset.name;

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
					{mod.name.startsWith("MCP_") && <button
						className="preset-panel__delete-btn"
						onClick={() => {
							const idx = config.mcps.findIndex(mcp => mcp.name === mod.name.slice(4));

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

const refreshTools = $computed(() => {
	return Object.entries(toolGroups).filter(([k, v]) => v.hidden !== true).map(([k, v]) => ({
		name: k,
		...v
	}));
}, [$computed(() => !!selectedConversation.ready)]);

function openSkillManager(preset, isOpen, close) {
	const [el, vl] = createList();

	$watchWithCleanup(refreshTools, () => {
		vl.setItems(unconscious(refreshTools));
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
								placeholder: "建议使用 PascalCase",
								id: "name",
								pattern: /^[a-zA-Z0-9_-]+$/,
								required: true
							},
							{
								type: "input",
								name: "服务器地址",
								placeholder: "仅支持SSE协议",
								id: "url",
								pattern: /.+/,
								required: true
							},
							{
								type: "textbox",
								name: "请求头",
								placeholder: "Authorization: Bearer xxx\n - 目前版本不支持，仅预留",
								id: "headers",
								pattern(value) {
									return [value.split("\n").map(item => item.split(": "))];
								},
							},
							{
								type: "input",
								name: "简介(给模型看)",
								placeholder: "Another MCP Server",
								id: "desc"
							}
						]} choices={state}/>;
						const modal = SimpleModal({
							title: "添加MCP服务器",
							message: filter,
							onConfirm() {
								const mcps = config.mcps;
								if (!mcps) config.mcps = [unconscious(state)];
								else {
									mcps.push(unconscious(state));
									$update(config);
								}

								queueMicrotask(refreshTools);
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