import {$computed, $foreach, $state, $update} from "unconscious";
import {cloneNamed} from "../utils/utils.js";
import {config, Shared} from "../states.js";
import SimpleModal from "./SimpleModal.jsx";
import {Dropdown} from "./Dropdown.jsx";
import {kvListDel, kvListGet, kvListGetKeys, kvListSet} from "../database.js";
import {onLoad} from "../plugin.js";
import {presetKeys, presetKeysAlways} from "../settings.js";

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
function LorebookList({items, selection}) {
	function toggleLorebook(id) {
		const x = selection.indexOf(id);
		if (x >= 0) selection.splice(x, 1);
		else selection.push(id);
	}

	return <div className="tag-dropdown">
		<button className="btn ghost">+ {() => selection.length ? "已选 "+selection.length+" 个类别" : "所有配置"}</button>
		<div className="list" onClick.delegate{"input"}={({delegateTarget}) => {
			toggleLorebook(delegateTarget.dataset.id);
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
	</div>;
}


export const createPreset = (name, categories) => {
	if (null == name) {
		const selection = $state([]);
		SimpleModal({
			type: 'input',
			title: "保存为新预设",
			placeholder: '给你的配置起个名字...',
			message: <>
				<span style="font-size:smaller">您可以选择仅保存特定部分的设置（如只存采样参数）。<br/>开启后，应用此预设将不会影响未选中的配置项。</span>
				<div style={"margin-bottom:8px;text-align:center"}><LorebookList items={Object.values(presetKeys)} selection={selection}/></div>
			</>,
			onConfirm(value) {
				createPreset(value, selection.value);
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

const setPreset = async i => {
	const presetKey = presets[i];
	const item = await kvListGet("preset", presetKey.name);
	delete item.type;

	Object.assign(config.value, item);
	$update(config);
	Shared.SettingUI.sync();
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