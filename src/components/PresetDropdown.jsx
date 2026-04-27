import {$computed, $state, $update} from "unconscious";
import {cloneNamed} from "../utils/utils.js";
import {config, Shared} from "../states.js";
import SimpleModal from "./SimpleModal.jsx";
import {PRESET_KEYS} from "../settings.js";
import {Dropdown} from "./Dropdown.jsx";
import {kvListDel, kvListGet, kvListGetKeys, kvListSet} from "../database.js";

/**
 * @type {import("unconscious").Reactive<AiChat.IDBKVList[]>}
 */
const presets = $state([]);

export async function reloadPresetList() {
	presets.value = await kvListGetKeys("preset");
}
reloadPresetList();

export function createPreset(name) {
	if (!name) {
		SimpleModal({
			type: 'input',
			placeholder: '请输入预设名称',
			onConfirm: createPreset
		});
		return;
	}

	config.name = name;

	kvListSet(cloneNamed(config, PRESET_KEYS), "preset", name).then(id => {
		_dropdown.onInserted(id, name);
	})
}

async function setPreset(i) {
	const item = await kvListGet(presets[i].id);
	delete item.type;

	Object.assign(config.value, item);
	$update(config);
	Shared.SettingUI.onSettingsUpdated();
	_dropdown.setSelection(i);
}

let _dropdown;

export function loadPreset(name) {
	const id = presets.findIndex(s => s.name === name);
	if (id < 0) return false;
	setPreset(id);
	return true;
}

/**
 * @constructor
 */
export function PresetDropdown() {
	const selectedPreset = $computed(() => config.name);
	const element = <Dropdown items={presets} selection={selectedPreset} dir={'up'}
							  onChanged={(type, index) => {
		if (type === 'd') {
			const [key] = presets.splice(index, 1);
			kvListDel(key.id);
		} else {
			setPreset(index);
		}
	}} />;
	_dropdown = element;
	return element;
}