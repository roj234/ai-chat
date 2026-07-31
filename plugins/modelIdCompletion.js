import {DI_settings, onLoad} from "/src/hooks.js";
import {models, updateModels} from "/src/states.js";
import {$foreach} from "unconscious";

onLoad((app) => {
	const DATALIST_ID = 'DL-modelIds';

	// 这个也可以做成小的不能再小的插件
	app.append(<datalist id={DATALIST_ID}>{$foreach(models, model =>
		<option value={model.id} label={(model.name||model.description)?.trim()}/>)
	}</datalist>);

	const modelInput = DI_settings.byId('model').children[0];
	modelInput.setAttribute("list", DATALIST_ID);
	modelInput.addEventListener("focus", () => updateModels());

	const titleModelInput = DI_settings.byId('titleModel').children[0];
	titleModelInput.setAttribute("list", DATALIST_ID);
	titleModelInput.addEventListener("focus", () => updateModels());
})