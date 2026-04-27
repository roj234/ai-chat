import {SETTINGS} from "/src/settings.js";
import {jsonFetch, prettyError} from "/src/utils/utils.js";
import {config} from "/src/states.js";

SETTINGS.push({
	name: "测试连接",
	type: "element",
	_tab: "model",
	element: <button className={"btn primary"} onClick={({target}) => {
		target.disabled = true;

		// Accept 400 Bad Request
		jsonFetch(config.endpoint+(config.mode === "chat" ? '/chat/completions' : '/completions'), {
			authorization: config.accessToken,
			body: JSON.stringify({
				model: "loremipsum",
				messages: [{ role: "user", content: "Hello" }],
				max_tokens: 1,
				stream: false
			})
		}).then(json => {
			return true;
		}).catch(err => {
			console.error(err);
			err = prettyError(err);
			err = err.substring(0, err.indexOf("\n"));
			return err.endsWith(" 400") || err.endsWith(" 500");
		}).then(result => {
			target.disabled = false;
			target.textContent = result ? "成功" : "失败";
		});
	}}>测试</button>
});