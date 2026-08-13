import {CUSTOM_CONTROLS} from "/src/settings.js";
import {loadPreset, presets} from "/src/components/PresetDropdown.jsx";
import {$computed, $foreach} from "unconscious";
import {config, selectedConversation} from "/src/states.js";
import "./PresetFastSwitch.css";

export const registerPresetFastSwitch = () => {
	const main = <div className={"pretty-select preset-switch up"} title={"快速选择预设"} style={"width: auto; max-width: 200px"} style:display={() => selectedConversation.presets ? 'none': ''}>
		<div className="input" onClick.stop={() => main.classList.toggle("open")}>
			<span>{() => config.name ?? "default"}</span>
			<span className={"arrow-icon ri-arrow-down-s-line"}></span>
		</div>

		<ul className="dropdown" onClick.stop.delegate{"li"}={({target}) => {
			loadPreset(target.textContent);
		}}>
			{$foreach($computed(() => presets.filter(item => !item.name.startsWith("_"))), (item) =>
				<li className={"ellipsis"} title={item.name}>{item.name}</li>, (item) => item.name)}
		</ul>
	</div>;

	CUSTOM_CONTROLS.unshift(main);
};
