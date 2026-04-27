import {onLoad} from "/src/plugin.js";
import {models, Shared, updateModels} from "/src/states.js";
import {$foreach} from "unconscious";

onLoad((app) => {
	// 这个也可以做成小的不能再小的插件
	app.append(<datalist id="ac-models">{$foreach(models, model =>
		<option value={model.id || model.model || model.name} label={model.name} title={model.description}/>)
	}</datalist>);

	const modelInput = Shared.SettingUI.querySelector('[data-id="model"] input');
	modelInput.setAttribute("list", "ac-models");
	modelInput.addEventListener("focus", () => updateModels());
})