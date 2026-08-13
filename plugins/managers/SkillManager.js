import SimpleModal from "/src/components/SimpleModal.jsx";
import {highlightJsonLike} from "/src/markdown/highlight.js";
import {$computed, $state, $update, $watch, $watchWithCleanup, unconscious} from "unconscious";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {addMCPServer, defaultGroups, PLACEHOLDERS, toolScriptRegistry, toolset} from "/src/toolset.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";

import "./SkillManager.css";
import "../rp_basic/PresetPanel.css";
import {ensureActiveConversation, selectedConversation} from "/src/states.js";
import {CUSTOM_CONTROLS} from "/src/settings.js";
import {Filter} from "unconscious/common/components/Filter.jsx";

import {createPanel} from "../rp_basic/CreatePanel.jsx";
import {onLoad} from "/src/hooks.js";
import {showToast} from "/src/components/Toast.js";
import {prettyError} from "/src/utils/utils.js";
import {getKV, setKV} from "/src/database.js";
import {MCPClient} from "/common/MCPClient.js";

const mcps = $state([]);
let registeredMcps;

PLACEHOLDERS["mdfmt"] = `- Use \`language:label\` in the code fence to set a display label and download filename.`;

const refreshTools = $computed(() => !selectedConversation.ready);
const currentTools = $computed(() => {
	return Object.entries(toolset).filter(([k, v]) => v.hidden !== true).map(([k, v]) => ({
		name: k,
		...v
	}));
}, [refreshTools]);

onLoad(() => {
	getKV('mcps', mcps);
	$watch(mcps, () => {
		const arr = unconscious(mcps);
		if (registeredMcps) setKV('mcps', arr.length ? arr : undefined);

		registeredMcps && registeredMcps.forEach(close => close());
		registeredMcps = arr.map(({url, name, desc, ...rest}) => addMCPServer(url, name, desc, rest));

		$update(refreshTools);
	}, false);

	addEventListener("beforeunload", () => {
		registeredMcps && registeredMcps.forEach(close => close());
	});
});

const isActivated = (conv, mod) => conv.activatedModules?.has(mod);

/**
 *
 * @return {[import("unconscious").Renderable, VirtualList]}
 */
function createList() {
	const list = <ul onClick.delegate{"input[type=checkbox]"}={async ({delegateTarget}) => {
		const key = delegateTarget.closest("li").dataset.name;

		await ensureActiveConversation();
		const conv = unconscious(selectedConversation);
		if (!conv.activatedModules) {
			conv.allowedTools = new Set;
			conv.activatedModules = new Set;
			//await toolScriptRegistry['Use'].script({modules: [...defaultGroups]}, {}, conv);
			//$update(selectedConversation);
		}

		const Use = toolScriptRegistry['Use'];
		const state = isActivated(conv, key);
		const modules = [key];

		try {
			if (!state) {
				await Use.script({modules}, {}, conv);
			} else {
				Use.undo({modules}, conv);
			}
		} catch (e) {
			showToast(prettyError(e), 'error', 0);
		}

		for (const name of modules) {
			const el = list.querySelector("li[data-name="+JSON.stringify(name)+"]");
			if (el) el.querySelector("input[type=checkbox]").checked = isActivated(conv, key);
		}
		$update(selectedConversation);
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
					{mod.tools?.length && <small title={mod.tools.join("\n")}>{mod.tools.length} 个工具</small>}
					{mod.data === "MCP" && <button
						className="preset-panel__delete-btn"
						onClick={() => {
							const idx = mcps.findIndex(mcp => mcp.name === mod.name);

							SimpleModal({
								title: "确认删除",
								message: <div dangerouslySetInnerHTML={highlightJsonLike(mcps[idx])}/>,
								accent: 'danger',
								onConfirm() {
									mcps.splice(idx, 1);
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
						checked={isActivated(selectedConversation, mod.name)}
					/>
				</div>
				{desc && renderMarkdownToElement(<div className={"md"}/>, desc)}
			</li>;
		},
		keyFunc(item) {
			return item.name+'/'+(isActivated(selectedConversation, item.name)?1:0);
		}
	});

	return [list, virtualList];
}


function openSkillManager(preset, isOpen, close) {
	const [el, vl] = createList();

	$watchWithCleanup(currentTools, () => {
		vl.setItems(unconscious(currentTools));
	});

	return (
		<div className={`preset-panel skill-manager`} class:open={isOpen}>
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
									if (mcps.find(mcp => mcp.name === name)) return "名称与现有MCP/工具集重复";
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
								placeholder: "支持 Streamable HTTP 和 SSE 协议",
								id: "url",
								pattern: /^https?:\/\/.+/,
								warning: "请输入正确的网址",
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
							async onConfirm() {
								const client = new MCPClient(state.url, {key: state.key});
								try {
									await client.connect();
								} catch (e) {
									showToast("连接失败:\n"+prettyError(e), 'error');
									return false;
								}

								const obj = unconscious(state);
								for (const key in obj) {
									if (!obj[key]) delete obj[key];
								}
								mcps.push(obj);
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
CUSTOM_CONTROLS.find(el => el.matches(".ri-robot-2-line")).addEventListener("click", async (e) => {
	e.preventDefault();
	await ensureActiveConversation();
	const open = unconscious(skillManagerPanel.isOpen);

	const conv = unconscious(selectedConversation);

	const ms = conv.activatedModules;
	if (!ms || (!open && !ms.size)) {
		conv.allowedTools = new Set;
		conv.activatedModules = new Set;
		await toolScriptRegistry['Use'].script({modules: [...defaultGroups]}, {}, conv);
		$update(selectedConversation);
		$update(refreshTools);
	}

	skillManagerPanel.open();
});