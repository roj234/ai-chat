import {DI_settings, onLoad} from "/src/hooks.js";
import {$computed, $foreach} from "unconscious";
import {models, presets, updateModels} from "../src/presets.js";

onLoad((app) => {
	const DATALIST_ID = 'DL-modelIds';
	const DATALIST_ID_2 = 'DL-providerIds';

	// 这个也可以做成小的不能再小的插件
	app.append(
		<datalist id={DATALIST_ID}>{$foreach(models, model =>
			<option value={model.id} label={(model.name || model.description)?.trim()}/>)
		}</datalist>,
		<datalist id={DATALIST_ID_2}>{$foreach($computed(() => presets.filter(item => item.name.includes('/'))), item => {
			return <option value={item.name} label={item.meta ?? item.name}/>
		}, item => item.name + '\0' + item.meta)}</datalist>
	);

	const modelInput = DI_settings.byId('model').children[0];
	modelInput.setAttribute("list", DATALIST_ID);
	modelInput.addEventListener("focus", () => updateModels());

	const titleModelInput = DI_settings.byId('titleModel').children[0];
	titleModelInput.setAttribute("list", DATALIST_ID_2);
})