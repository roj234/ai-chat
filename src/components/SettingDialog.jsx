import {jsHide} from "../utils/utils.js";
import {$state, $watch} from "unconscious";
import {SETTINGS} from "../settings.js";

import "./SettingDialog.css";
import {PresetDropdown} from "./PresetDropdown.jsx";
import {isMobile} from "../states.js";
import {ITEM_KEY} from "unconscious/ext/VirtualList.js";

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
export function createTab(id, name, icon, after) {
	if (id in tabs) return;
	tabs[id] = {
		name: <span className={"group "+icon}>{name}</span>,
		elements: []
	};
}

createTab("general", "通用", "ri-wrench-line");
createTab("model", "模型", "ri-key-line");
createTab("sampling", "采样", "ri-filter-line");
createTab("prompt", "Prompt", "ri-menu-2-line");
createTab("customize", "个性化", "ri-brush-line");
createTab("appearance", "外观", "ri-brush-line");
createTab("data", "数据管理", "ri-database-2-line");
createTab("tools", "工具调用", "ri-server-line");

function setTransparent(f) {
	document.body?.classList.toggle("tr", f);
}

export function SettingDialog(oldUI) {
	const elements = Array.from(oldUI.children);
	for (let i = 0; i < SETTINGS.length; i++) {
		const item = SETTINGS[i];
		const element = elements[i];
		let tabNames = item._tab || "general";
		if (!Array.isArray(tabNames)) tabNames = [tabNames];

		for (const tabName of tabNames) {
			element[ITEM_KEY] = item;
			const val = tabs[tabName];
			if (val) val.elements.push(element);
			else tabs[tabName] = {
				name: tabName,
				elements: [element]
			};
		}
	}

	Object.entries(tabs).forEach(([key, {elements}]) => {
		if (!elements.length) delete tabs[key];
		else elements.sort((a, b) => (a[ITEM_KEY]._order||0) - (b[ITEM_KEY]._order||0));
	});

	let header;
	let body;
	let dialog = <div className="modal-overlay hide" id={"settingDialog"} style={"display:none;z-index:"+(isMobile?16:15)}>
		<div ref={header} className="modal ntp">
			<div className="sidebar-list scroll">
				<div className={"_vl"} onClick.delegate{".chat-item"}={({delegateTarget}) => {
					delegateTarget.parentElement.querySelector(".active").classList.remove("active");
					delegateTarget.classList.add("active");
					currentTab.value = delegateTarget.dataset.tab;
				}}>
					{Object.entries(tabs).map(([id, {name}]) => {
						return <div className={"chat-item"+(currentTab.value === id?" active":"")} data-tab={id}><span className="chat-title">{name}</span></div>;
					})}
				</div>
			</div>

			<div style={"flex:1;display:flex;flex-direction:column;overflow:hidden"}>
				<div className="header"><b>{() => {
					const x = tabs[currentTab.value].name;
					return typeof x === "string" ? x : x.cloneNode(true);
				}}</b>
					<button className="ri-close-line btn ghost" style={"border:none"}
							onClick={() => {
								setTransparent(false);
								jsHide(dialog);
							}}></button>
				</div>
				<div ref={body} className="filter" style={"flex:1;" +
					"border:none;" +
					"overflow:auto;" +
					"scrollbar-gutter:stable;" +
					"padding-right:6px;"}></div>
				<div className={"footer"}>{<PresetDropdown/>}</div>
			</div>
		</div>
	</div>;

	$watch(currentTab, () => {
		body.replaceChildren(...tabs[currentTab.value].elements);
		setTransparent(currentTab.value === "appearance");
	});

	dialog.showHide = (pattern, display) => {
		for (let element of elements) {
			if (element.dataset.id?.startsWith(pattern)) {
				element.style.display = display ? '' : 'none'
			}
		}
	};
	return dialog;
}