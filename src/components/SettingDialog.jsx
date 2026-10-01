import {$computed, $state, $update, $watch, appendChild, ref, unconscious} from "unconscious";
import {presetCategories} from "../settings.js";

import "./SettingDialog.css";
import {ITEM_KEY} from "unconscious/common/VirtualList.js";
import {openWindow} from "./Windows.jsx";
import Filter from "unconscious/common/components/Filter.jsx";
import {immutableObjectMap} from "unconscious/common/Utils.js";
import {isIDB, kvListGet, kvListSet} from "../database.js";
import {resolveDBRelativeURL} from "../utils/utils.js";
import {AsyncButton} from "./AsyncButton.jsx";
import {auxSmallScreen, config, CONFIG_VERSION, LOCKED} from "../states.js";
import {PRESET_KVS_ID, presets, PromptDropdown, ProviderDropdown} from "../presets.js";

let currentTab = $state("general");
/**
 *
 * @type {Record<string, {
 *     name: HTMLElement | string,
 *     elements: HTMLElement[]
 * }>}
 */
let tabs = {};
//let tabOrder = [];

/**
 *
 * @param {string} id
 * @param {string} name
 * @param {string} icon
 * @param {string=} after 未实现
 */
export const createTab = (id, name, icon, after) => {
	if (id in tabs) return;
	tabs[id] = {
		icon,
		name,
		elements: []
	};
};

const NEW_PROVIDER_TAB = immutableObjectMap({
	"model": "基础参数",
	"sampling": "采样参数",
	"model2": "高级配置",
});

createTab("general", "通用", "ri-wrench-line");
createTab("provider", "模型", "ri-key-line");
createTab("prompt", "提示词", "ri-menu-2-line");
createTab("customize", "个性化", "ri-brush-line");
createTab("data", "数据", "ri-database-2-line");
createTab("tools", "工具", "ri-wrench-line");

/**
 *
 * @param {Array} optionsArray
 * @param {import("unconscious").Reactive<AiChat.Preset>} settings
 * @param {Function} onSettingChanged
 * @return {{showHide: showHide, show(): void, byId: (function(string): HTMLElement), sync(boolean, boolean)}}
 */
export function createSettingDialog(optionsArray, settings, onSettingChanged) {
	if (auxSmallScreen) optionsArray.forEach(item => delete item.inline);

	/** @type {import("unconscious/common/components/Filter").FilterInstance} */
	const oldUI = <Filter config={optionsArray} choices={settings} onChange={onSettingChanged}/>;

	const byId = new Map;
	const elements = [...oldUI.querySelectorAll(".filter-row")];
	for (let i = 0; i < optionsArray.length; i++) {
		const item = optionsArray[i];
		let element = elements[i];

		let tabNames = item._tab || "general";
		if (!Array.isArray(tabNames)) tabNames = [tabNames];
		const id = item.id || item._id;
		if (id) byId.set(id, element.lastElementChild);

		if (element.parentElement.className === "filter-inline") {
			element = element.parentElement;
		}
		element[ITEM_KEY] = item;

		for (const tabName of tabNames) {
			const val = tabs[tabName];
			if (val) val.elements.push(element);
			else tabs[tabName] = {
				name: tabName,
				elements: [element]
			};
		}
	}

	const filtered = Object.entries(tabs).filter(([key, {elements}]) => {
		return elements.length && !(NEW_PROVIDER_TAB[key]) && elements.sort((a, b) => (a[ITEM_KEY]._order || 0) - (b[ITEM_KEY]._order || 0));
	});

	let body;
	let dialog = <div className="ntp">
		<div className={"col"}>
			<div className="sidebar-list scroll">
				<div className={"_vl"} onClick.delegate{".chat-item"}={({delegateTarget}) => {
					delegateTarget.parentElement.querySelector(".active").classList.remove("active");
					delegateTarget.classList.add("active");
					currentTab.value = delegateTarget.dataset.tab;
				}}>
					{filtered.map(([id, {icon, name}]) => {
						return <div className={"chat-item" + (unconscious(currentTab) === id ? " active" : "")}
									data-tab={id} tabIndex={0} role={"button"}>
							<span className={"chat-title " + icon}>{name}</span></div>;
					})}
				</div>
			</div>
		</div>
		<div ref={body} className="filter"/>
	</div>;

	const computedProviders = $computed(() => {
		const cates = {};
		for (const item of presets) {
			const name = item.name;
			if (name[0] === ':') continue;

			const pos = name.indexOf('/');
			const arr = cates[pos < 0 ? name : name.slice(0, pos)] ??= [];
			if (pos > 0) arr.push(name);
		}
		const out = [
			{name: "编辑供应商\u200C", desc: "供应商配置", className: "provider", [LOCKED]: true},
			{name: "/编辑模型\u200C", desc: "模型配置", className: "model", [LOCKED]: true},
			{name: "\u200C", desc: "-- 载入配置 --", className: "splitter", [LOCKED]: true},
		];

		for (const key in cates) {
			out.push({name: key, desc: key, className: "provider"});
			for (const val of cates[key]) {
				out.push({name: val, desc: val.slice(key.length + 1), className: "model"});
			}
		}

		return out;
	});
	const selectedProvider = $state(computedProviders[1].name);
	const isModelTab = () => unconscious(selectedProvider).includes('/');

	let providerTest = ref();
	const tabKeys = <div className="tabs">
		{Object.keys(NEW_PROVIDER_TAB).map((key) => <button data-tab={key} onClick={(e) => {
			const el = tabKeys.querySelector(".active");
			const self = e.target;
			if (el === self) return;

			el?.classList.remove("active");
			tabValue.replaceChildren(...tabs[self.dataset.tab].elements);
			self.classList.add("active");
		}}>{NEW_PROVIDER_TAB[key]}</button>)}
	</div>;
	const tabValue = <div className="tab-content"/>;
	const tabHeader  = <div className="col-detail">
		<div className="row" ref={providerTest}>
			<ProviderDropdown items={computedProviders} selection={selectedProvider}/>
			<AsyncButton className="btn primary" onClick={async () => {
				const modelTab = isModelTab();
				const providerName = settings.provider || new URL(resolveDBRelativeURL(config.endpoint)).host;
				const name = modelTab ? providerName + '/' + settings.model : providerName;

				const data = isIDB ? Object.create(null) : await kvListGet(PRESET_KVS_ID, name).catch(() => (Object.create(null)));
				const set = unconscious(settings);
				for (const category of modelTab ? ["model", "sampling"] : ["provider"]) {
					const catData = presetCategories[category];
					const keys = catData.keys;
					for (let i = 0; i < keys.length; i++) {
						const key = keys[i];
						if (set[key] !== catData.values[i].default) data[key] = set[key];
					}
				}

				const modelName = modelTab && set.name;
				if (modelName) data.meta = modelName;
				else delete data.meta;

				return kvListSet(data, PRESET_KVS_ID, name).then(() => {
					config[CONFIG_VERSION] = (config[CONFIG_VERSION] || 0) + 1;
					$update(presets);
				});
			}}>保存</AsyncButton>
		</div>
		{() => unconscious(selectedProvider).includes("/") ? tabKeys : <div style="height:12px"/>}
	</div>;

	$watch(selectedProvider, () => {
		if (isModelTab()) {
			const active = tabKeys.querySelector(".active");
			if (!active) tabKeys.children[0].click();
			else tabValue.replaceChildren(...tabs[active.dataset.tab].elements);
		} else {
			tabValue.replaceChildren(...tabs["provider"].elements);
		}
	});

	$watch(currentTab, () => {
		if (unconscious(currentTab) === "provider") {
			body.classList.add("sd-provider");
			body.replaceChildren(tabHeader, tabValue);
			return;
		}

		body.classList.remove("sd-provider");
		body.replaceChildren(...tabs[unconscious(currentTab)].elements);
	});

	appendChild(byId.get("systemPrompt"), <PromptDropdown/>);

	// 插槽
	byId.set("provider", providerTest);
	byId.set("providerTab", selectedProvider);

	let showHide = (pattern, display) => {
		for (let element of elements) {
			if (element.dataset.id?.startsWith(pattern)) {
				element.style.display = display ? '' : 'none'
			}
		}
	};

	return {
		showHide,
		show() {
			openWindow({
				id: "settings",
				icon: () => <span className={() => tabs[unconscious(currentTab)].icon}/>,
				title: () => tabs[unconscious(currentTab)].name + "设置",
				element: dialog,
				//actions: <PresetDropdown/>,
				width: 768,
				height: 900,
				reuse: true
			})
		},
		sync(readFromChoices, skipEmit) {
			oldUI.sync(readFromChoices, skipEmit);
		},
		byId: id => byId.get(id)
	};
}