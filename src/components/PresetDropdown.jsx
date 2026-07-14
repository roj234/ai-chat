import {$computed, $foreach, $state, $update, unconscious} from "unconscious";
import {cloneNamed} from "../utils/utils.js";
import {config} from "../states.js";
import SimpleModal from "./SimpleModal.jsx";
import {Dropdown} from "./Dropdown.jsx";
import {kvListDel, kvListGet, kvListGetKeys, kvListSet} from "../database.js";
import {DI_settings, onLoad} from "../hooks.js";
import {presetKeys, presetKeysAlways, SETTINGS} from "../settings.js";

/**
 * @type {import("unconscious").Reactive<AiChat.IDBKVList[]>}
 */
export const presets = $state([]);

export const reloadPresetList = () => kvListGetKeys("preset", presets);
onLoad(reloadPresetList);


/**
 * @template {Object & AiChat.IDBKVList} T
 * @param {import("unconscious").Reactive<T[]>} items
 * @param {import("unconscious").Reactive<number[]>} selection
 */
function SettingList({items, selection}) {
	function toggle(id) {
		const x = selection.indexOf(id);
		if (x >= 0) selection.splice(x, 1);
		else selection.push(id);
	}

	return <div>
		<div onClick.delegate{"input"}={({delegateTarget}) => {
			toggle(delegateTarget.dataset.id);
		}}>
			{$foreach(items, ({id, name}) => (
				<label>
					<input
						data-id={id}
						type="checkbox"
						checked={selection.includes(id)}
					/> {name}
				</label>
			))}
		</div>
		<div>{() => selection.length ? "已选 " + selection.length + " 个类别" : "未勾选：保存所有配置"}</div>
	</div>;
}


const createPreset = (name, categories) => {
	if (null == name) {
		const selection = $state([]);
		SimpleModal({
			type: 'input',
			title: "保存为新预设",
			placeholder: '给你的配置起个名字...',
			message: <>
				<span style="font-size:smaller">勾选需要保存在预设中的设置项。应用预设时，仅更新已选项，其余设置保持不变。</span>
				<div style={"margin-bottom:8px;text-align:center"}><SettingList items={Object.values(presetKeys)} selection={selection}/></div>
			</>,
			onConfirm(value) {
				createPreset(value, unconscious(selection));
			}
		});
		return;
	}

	if (name) config.name = name;
	else name = config.name;

	const keysToClone = [...presetKeysAlways];
	if (!categories.length) categories = Object.keys(presetKeys);

	for (const category of categories) {
		keysToClone.push(...presetKeys[category].keys);
	}

	const clonedObject = cloneNamed(config, keysToClone);

	kvListSet(clonedObject, "preset", name).then(() => {
		_dropdown.onInserted("preset", name);
	})
};

SETTINGS.push(
	{
		type: "element",
		_id: "pb", // 见 SettingDialog 中处理逻辑，以及引用它的 configSync.js
		_tab: ["general", "data"],
		_order: -1,
		name: "当前配置",
		element: <div className={"choice-scroll"}>
			<button className="btn ghost" onClick={() => createPreset()}>保存到预设</button>
		</div>
	},
);

const setPreset = async i => {
	const presetKey = presets[i];
	const item = await kvListGet("preset", presetKey.name);
	delete item.type;

	Object.assign(config.value, item);
	$update(config);
	DI_settings.sync();
	_dropdown.setSelection(i);
};

let _dropdown;

export const loadPreset = name => {
	const id = presets.findIndex(s => s.name === name);
	if (id < 0) return false;
	setPreset(id);
	return true;
};

export function PresetDropdown() {
	const selectedPreset = $computed(() => config.name);
	const element = <Dropdown items={presets} selection={selectedPreset} dir={'up'}
							  onChanged={(type, index) => {
		if (type === 'd') {
			const [key] = presets.splice(index, 1);
			kvListDel("preset", key.name);
		} else {
			setPreset(index);
		}
	}} />;
	_dropdown = element;
	return element;
}