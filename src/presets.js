import {DI_settings, onLoad} from "./hooks.js";
import {kvListDel, kvListGet, kvListGetKeys, kvListSet} from "./database.js";
import {$asyncState, $computed, $state, $update, unconscious} from "unconscious";
import {cloneNamed, prettyError, resolveDBRelativeURL} from "./utils/utils.js";
import {deepEqual} from "unconscious/common/deepEqual.js";
import {jsonFetch} from "../common/openai-api-utils.js";
import {config, CONFIG_VERSION, LOCKED} from "./states.js";
import {showToast} from "./components/Toast.js";
import {throttledPromiseLast} from "../common/pure-utils.js";
import {Dropdown} from "./components/Dropdown.jsx";
import {presetCategories} from "./settings.js";
import SimpleModal from "./components/SimpleModal.jsx";

export const PRESET_KVS_ID = 'preset';

/**
 * @type {import("unconscious").Reactive<AiChat.IDBKVList[]>}
 */
export const presets = $state([]);

onLoad(() => kvListGetKeys(PRESET_KVS_ID, presets));

/**
 * @type {import("unconscious").Reactive<{}>}
 * @private
 */
const _modelEndpoint = $state();

/**
 * @type {boolean}
 */
export let isLlamaCppBackend, isMyLlamaCppBackend;

export const setIsLlamaCppBackend = (b, b2) => {
	isLlamaCppBackend = b;
	isMyLlamaCppBackend = b2;
};

/**
 * @type {import("unconscious").ReactivePromise<AiChat.ApiModel[]>}
 */
export const models = $asyncState(endpoint => {
	return endpoint?.url ? jsonFetch(resolveDBRelativeURL(endpoint.url) + "/models", {key: endpoint.key}).then(({data}) => data) : [];
}, _modelEndpoint);

/**
 * @param {boolean=} force
 * @return {import("unconscious").ReactivePromise<AiChat.ApiModel[]>}
 */
export const updateModels = force => {
	const value = {
		url: resolveDBRelativeURL(config.endpoint),
		key: config.accessToken
	};
	if (force || !deepEqual(value, _modelEndpoint.value)) _modelEndpoint.value = value;
	return models;
};

/**
 *
 * @param {string} name
 * @return {Promise<void>}
 */
const setPreset = async name => {
	const isPrompt = name[0] === ':';
	const isModel = name.indexOf('/');
	let p = [
		{},
		kvListGet(PRESET_KVS_ID, isModel > 0 ? name.slice(0, isModel) : name)
	];
	if (isModel > 0) p.push(kvListGet(PRESET_KVS_ID, name));
	let data = (await Promise.all(p)).reduce(Object.assign);
	data.name = data.meta;

	const set = unconscious(config);

	for (const category of isPrompt ? ["prompt"] : isModel > 0 ? ["model", "sampling", "provider"] : ["provider"]) {
		const catData = presetCategories[category];
		const keys = catData.keys;
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			set[key] = data[key] ?? catData.values[i].default;
		}
	}

	delete config._dirty;
	DI_settings.sync();
	$update(config);

	instance.setSelection(name);
};

let instance;

export const loadPreset = name => setPreset(name).then(() => true, (e) => {
	showToast(`配置 ${name} 加载失败\n` + prettyError(e), 'error');
});

export function ProviderDropdown({items, selection}) {
	const doSetSelection = throttledPromiseLast(async name => {
		const isModel = name.indexOf('/');
		if (!name.endsWith("\u200C")) {
			if (!await loadPreset(name)) return;
			name = items[+(isModel > 0)].name;// = `${isModel > 0 ? '/模型' : '供应商'} (${name})\u200C`;
		}

		selection.value = name;
		dropdown.setSelection(name);
	});

	const dropdownOnChange = (action, name) => {
		if (action === 'd') {
			let p = [];
			p.push(kvListDel(PRESET_KVS_ID, name));
			if (!name.startsWith('/')) {
				name += '/';
				presets.forEach(item => item.name.startsWith(name) && p.push(kvListDel(PRESET_KVS_ID, item.name)));
			}
			Promise.all(p).catch((e) => {
				showToast("部分删除失败\n"+prettyError(e), 'error');
			});
		} else if (action === 's') {
			doSetSelection(name);
		}
	};

	const dropdown = <Dropdown items={items} selection={selection} displayName="desc" onChanged={dropdownOnChange} />;

	instance = dropdown;

	return dropdown;
}

export function PromptDropdown() {
	const items = $computed(() => {
		const out = [
			{ name: "\u200C默认", [LOCKED]: true },
			{ name: "\u200C禁用 (完全无系统提示)", [LOCKED]: true },
		];
		for (const t of presets) {
			if (t.name[0] === ':') {
				out.push({ name: t.name.slice(1) });
			}
		}

		return out;
	});
	let prevName;

	return <Dropdown items={items} selection={"选择……"} dir={'down'}
		onChanged={(type, name) => {
			prevName = null;

			if (type === 'd') {
				kvListDel(PRESET_KVS_ID, ':'+name);
			} else {
				if (name[0] === '\u200C') {
					config.systemPrompt = name === "\u200C默认" ? "" : "---\n---";
					DI_settings.sync(false, true);
					return;
				}

				loadPreset(':'+name).then(() => prevName = name);
			}
		}} add={(name) => {
			SimpleModal({
				type: 'input',
				title: "保存提示词",
				placeholder: '起个名字...',
				value: name || prevName,
				onConfirm(value) {
					if (!value) return false;

					const cfg = cloneNamed(config, presetCategories["prompt"].keys);

					config[CONFIG_VERSION] = (config[CONFIG_VERSION] || 0) + 1;
					kvListSet(cfg, PRESET_KVS_ID, ":" + value);
				}
			});
	}}/>;
}