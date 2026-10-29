import {$computed, $vforeach, unconscious} from "unconscious";
import {config, selectedConversation} from "/src/states.js";
import "./PresetFastSwitch.css";
import {updateConversation} from "/src/database.js";
import {loadPreset, manualOverrideKeys, markCombinedPresetDirty, presets} from "/src/presets.js";
import {CUSTOM_CONTROLS} from "../src/customControls.js";

const getLockedPresetName = () => {
	const p = selectedConversation.presets;
	if (!p) return;
	return Array.isArray(p) ? p.join(" ") : presets.find(item => item.name === p)?.meta ?? p;
};

const currentPreset = $computed(() => getLockedPresetName() ?? ((config._dirty||'') + (config.name || config.model)));
const main = <div className={"pretty-select preset-switch up"} style={"width: auto; max-width: min(200px, 30vw)"}>
	<div className="input" tabIndex={0} role="button" title={"预设切换菜单"} onClick.stop={() => main.classList.toggle("open")}>
		<span className={"ri-lock-line"} title={"锁定当前对话的预设"}
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
