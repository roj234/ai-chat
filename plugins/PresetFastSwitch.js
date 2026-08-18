import {CUSTOM_CONTROLS} from "/src/settings.js";
import {loadPreset, presets} from "/src/components/PresetDropdown.jsx";
import {$computed, $foreach, unconscious} from "unconscious";
import {config, selectedConversation} from "/src/states.js";
import "./PresetFastSwitch.css";
import {markCombinedPresetDirty, updateConversation} from "/src/database.js";

const getLockedPresetName = () => {
	const p = selectedConversation.presets;
	if (!p) return;
	return Array.isArray(p) ? p.join(" ") : p;
};

export const registerPresetFastSwitch = () => {
	const main = <div className={"pretty-select preset-switch up"} title={"预设切换菜单"} style={"width: auto; max-width: 200px"}>
		<div className="input" onClick.stop={() => main.classList.toggle("open")}>
			<span className={"ri-lock-line"} title={"锁定当前对话的预设"}
				  style:display={() => unconscious(selectedConversation) ? '' : 'none'}
				  class:locked={() => selectedConversation.presets}
				  onClick.stop={e => {
				const conv = unconscious(selectedConversation);
				if (conv.presets) {
					delete selectedConversation.presets;
				} else {
					selectedConversation.presets = config.name;
				}
				markCombinedPresetDirty(conv);
				updateConversation(conv);
			}} />
			{() => getLockedPresetName() ?? config.name ?? "default"}
			<span className={"arrow-icon ri-arrow-down-s-line"}></span>
		</div>

		<ul className="dropdown" onClick.stop.delegate{"li"}={({target}) => {
			const conv = unconscious(selectedConversation);
			if (conv?.presets) {
				selectedConversation.presets = target.textContent;
				updateConversation(conv);
				markCombinedPresetDirty(conv);
			} else {
				loadPreset(target.textContent);
			}
		}}>
			{$foreach($computed(() => presets.filter(item => !item.name.startsWith("_"))), (item) =>
				<li className={"ellipsis"} class:selected={() => selectedConversation.presets === item.name} title={item.name}>{item.name}</li>, (item) => item.name)
			}
		</ul>
	</div>;

	CUSTOM_CONTROLS.unshift(main);
};
