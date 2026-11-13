import {$computed, $vforeach, unconscious} from "unconscious";
import {config, EVENT_BUS, selectedConversation} from "/src/states.js";
import "./PresetFastSwitch.css";
import {kvListGet, updateConversation} from "/src/database.js";
import {
	getProviderId,
	loadPreset,
	manualOverrideKeys,
	markCombinedPresetDirty,
	PRESET_KVS_ID,
	presets
} from "/src/presets.js";
import {CUSTOM_CONTROLS} from "/src/customControls.js";
import {showToast} from "/src/components/Toast.js";

const getLockedPresetName = () => {
	const p = selectedConversation.presets;
	if (!p) return;
	return Array.isArray(p) ? p.join(" ") : presets.find(item => item.name === p)?.meta ?? p;
};

const currentPreset = $computed(() => getLockedPresetName() ?? ((config._dirty||'') + (config.name || config.model)));
const main = <div className={"pretty-select preset-switch up"} style={"width: auto; max-width: min(200px, 30vw)"}>
	<div className="input" tabIndex={0} role="button" title={"模型选单"} onClick.stop={() => main.classList.toggle("open")}>
		<span className={"ri-lock-line"} title={"锁定此对话的模型"}
			style:display={() => unconscious(selectedConversation) ? '' : 'none'}
			class:locked={() => selectedConversation.presets}
			onClick.stop={e => {
				const conv = unconscious(selectedConversation);
				if (conv.presets) {
					delete selectedConversation.presets;
					const ovrd = conv.overrides;
					if (ovrd) {
						for (const key of manualOverrideKeys) {
							delete ovrd[key];
						}
					}
				} else {
					selectedConversation.presets = config.provider+'/'+config.model;
				}
				markCombinedPresetDirty(conv);
				updateConversation(conv);
			}} />
		<span className="ellipsis" title={currentPreset}>{currentPreset}</span>
		<span className="arrow-icon ri-arrow-down-s-line"></span>
	</div>

	<div className="dropdown">
		<ul role="list" onClick.stop.delegate{"li"}={(e) => {
			const conv = unconscious(selectedConversation);
			const id = e.target.title;
			if (conv?.presets) {
				selectedConversation.presets = id;
				updateConversation(conv);
				markCombinedPresetDirty(conv);
			} else {
				loadPreset(id);
			}

			if (e.pointerId < 0) main.classList.remove("open");
		}}>
			{$vforeach($computed(() => presets.filter(item => item.name.includes('/'))), (item) => {
				const name = item.name;
				let displayName = item.meta;
				if (displayName == null) {
					let idx = name.indexOf('/');
					displayName = name.slice(idx + 1) + ` (${name.slice(0, idx)})`
				}
				return <li className="ellipsis" role="listitem" tabIndex={0}
						   class:selected={() => selectedConversation.presets === name}
						   title={name}>{displayName}</li>;
			}, (item) => item.name + '\0' + item.meta)}
		</ul>
	</div>
</div>;

CUSTOM_CONTROLS.unshift(main);
EVENT_BUS.on(['convNew'], async (conv) => {
	const presetId = getProviderId(unconscious(config))+'/'+config.model;
	try {
		await kvListGet(PRESET_KVS_ID, presetId);
		conv.presets = presetId;
	} catch (e) {
		showToast("当前会话的模型/供应商未自动锁定");
	}
});
