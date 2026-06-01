import {SETTINGS} from "/src/settings.js";
import {jsonFetch, prettyError} from "/src/utils/utils.js";
import {config, Shared} from "/src/states.js";
import {provider_presets} from "/media/provider_presets.js";
import {onLoad} from "../src/plugin.js";
import {$state, $watch, unconscious} from "unconscious";

const templateAvailable = $state();

onLoad((app) => {
	app.append(<datalist id="ac-providers">{Object.entries(provider_presets).map(([k, v]) =>
		<option value={k} label={v.description||v.provider}/>
	)}</datalist>);

	const providerInput = Shared.SettingUI.querySelector('[data-id="endpoint"] input');
	providerInput.setAttribute("list", "ac-providers");

	$watch(config, () => {
		templateAvailable.value = provider_presets[config.endpoint];
	})
});

SETTINGS.push({
	name: "测试",
	type: "element",
	_tab: "model",
	element: <div className={"choice-scroll"}>
		<button className={"btn primary"} disabled={() => !unconscious(templateAvailable)} onClick={({target}) => {
			const setText = text => {
				target.innerText = text;
				setTimeout(() => {
					target.innerText = "应用配置模板";
				}, 1000);
			};

			const preset = unconscious(templateAvailable);
			if (!preset) {
				setText("未找到模板")
				return;
			}

			const {description, models, ...patch} = preset;

			Object.assign(config, patch);

			const perModelPreset = models[config.model];
			if (perModelPreset) Object.assign(config, perModelPreset);

			setText("应用成功");
			Shared.SettingUI.sync();
		}}>应用配置模板
		</button>

		<button className={"btn primary"} onClick={({target}) => {
			target.disabled = true;

			// Accept 400 Bad Request
			jsonFetch(config.endpoint + (config.mode === "chat" ? '/chat/completions' : '/completions'), {
				key: config.accessToken,
				body: JSON.stringify({
					model: "loremipsum",
					messages: [{role: "user", content: "Hello"}],
					max_tokens: 1,
					stream: false
				})
			}).then(json => {
				return true;
			}).catch(err => {
				console.error(err);
				err = prettyError(err);
				err = err.slice(0, err.indexOf("\n"));
				return err.endsWith(" 400") || err.endsWith(" 500");
			}).then(result => {
				target.disabled = false;
				target.textContent = result ? "成功" : "失败";
			});
		}}>测试连接
		</button>
	</div>
});