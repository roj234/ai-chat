import {CUSTOM_CONTROLS} from "/src/settings.js";
import {loadPreset, presets} from "/src/components/PresetDropdown.jsx";
import {$foreach} from "unconscious";
import {config} from "/src/states.js";

const main = <div className={"pretty-select up"} style={"width: auto; max-width: 200px"}>
	<div className="input" onClick.stop={() => main.classList.toggle("open")}>
		<span>{() => config.name ?? "default"}</span>
		<span className={"arrow-icon ri-arrow-down-s-line"}></span>
	</div>

	<ul className="dropdown" style={"min-width: 200px"}
		onClick.stop.delegate{"li"}={({target}) => {
		loadPreset(target.textContent);
	}}>
		{$foreach(presets, (item) =>
			<li className={"ellipsis"} style={"display:block"} title={item.name}>{item.name}</li>, (item) => item.name)}
	</ul>
</div>;

CUSTOM_CONTROLS.unshift(main);