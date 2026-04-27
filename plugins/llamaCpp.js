import {config, isLlamaCppBackend, models, setIsLlamaCppBackend, updateModels} from "/src/states.js";
import {$asyncState, $computed, $disposable, $foreach, $state, $unwatch, $update, $watch} from "unconscious";
import {isLanAddress} from "/src/utils/isLanAddress.js";
import "./llamaCpp.css";
import {jsonFetch, prettyError, throttled} from "/src/utils/utils.js";
import {SETTINGS} from "/src/settings.js";
import {showToast} from "/src/components/Toast.js";
import {isEqual} from "/vendor/equals.js";
import {setStatus} from "/src/api-request.js";
import {onLoad} from "/src/plugin.js";

const _endpoint = $state({});
const _stateChanging = $state("");

// token计数
let emptyMessageTokens = -1;
{
	let userInput;
	async function countTokens(text) {
		if (emptyMessageTokens < 0) {
			emptyMessageTokens = await _countTokens("");
		}
		return await _countTokens(text) - emptyMessageTokens;
	}
	const _countTokens = (text) => {
		return jsonFetch(config.endpoint+"/messages/count_tokens", {
			authorization: config.accessToken,
			body: JSON.stringify({
				model: config.model,
				messages: [{
					role: "user",
					content: text
				}]
			})
		}).then(result => result.input_tokens);
	};
	const delayedCountTokens = throttled(() => {
		if (!config.countTokens) return;

		const value = userInput.value;
		if (!value) {
			setStatus("");
			return
		}

		if (isLlamaCppBackend) {
			countTokens(value).then(token_count => {
				setStatus(token_count+" Tokens");
			});
		}
	}, 200);
	onLoad(() => {
		userInput = document.getElementById("userInput");
		userInput.addEventListener("input", delayedCountTokens);
	});
}


/**
 * @type {import("unconscious").ReactivePromise<boolean>}
 */
const isLLaMACppRouter = $asyncState(({url, token}) => {
	emptyMessageTokens = -1;
	setIsLlamaCppBackend(false, false);
	if (!url) return false;
	return jsonFetch(url+"props", { authorization: token }).then(json => {
		setIsLlamaCppBackend(true, json.build_info.startsWith("b114514"));
		return json.role === "router";
	});
}, _endpoint);

$watch(config, () => {
	const url = config.endpoint;
	const value = {
		// remove v1 postfix
		url: isLanAddress(url) ? url.substring(0, url.length-2) : "",
		token: config.accessToken
	};
	if (isEqual(value, _endpoint.value)) return;
	_endpoint.value = value;
	if (isLLaMACppRouter.error) $update(_endpoint);
});

let closeToast;
$watch(isLLaMACppRouter, () => {
	if (isLLaMACppRouter.error.startsWith?.("网络连接失败")) {
		closeToast = showToast(<>本地网络后端连接失败<br/>请确认后端已经启动<br/><button className={"btn primary"} onClick={({target}) => {
			$update(_endpoint);
		}}>重试</button></>, "error", 0);
	} else {
		closeToast?.();
		closeToast = null;
	}
})

const updateModelInfo = new IntersectionObserver(([entry]) => {
	if (isLlamaCppBackend && entry.isIntersecting) updateModels(true);
});

const BUTTON_STYLES = {
	'loaded': 'danger',
	'unloaded': 'primary'
};

SETTINGS.push({
	type: "element",
	_tab: "model",
	element: $computed(() => {
		if (!isLLaMACppRouter.loading && isLLaMACppRouter.value && !isLLaMACppRouter.error) {
			const div = <div className="filter-row">
				<div className="filter-label">[llama] 模型路由管理</div>
				<div className={"llama"}>
					{$foreach(models, model => {
						const status = model.status?.value;
						if (!status) return;
						return <div className="model">
							<div>
								<span>{model.id}</span>
								<small>{status}</small>
							</div>
							<button className={"btn "+(BUTTON_STYLES[status]??"ghost")}
									disabled={() => _stateChanging.value || status === "loading"}
									onClick={() => {
										llamaModelManage(model);
									}}
							>{status === 'unloaded' ? '加载' : '卸载'}
							</button>
						</div>
					})}
				</div>
			</div>;

			updateModelInfo.observe(div);
			$disposable(div, () => {updateModelInfo.unobserve(div);});
			return div;
		} else {
			return null;
		}
	})
},
{
	id: "countTokens",
	_tab: "customize",
	name: "统计输入框的 Token 数量",
	title: "仅支持 llama.cpp 后端，路由模式下可能意外加载模型。",
	type: "radio",
	choices: {
		"启用": true,
	}
});

/**
 *
 * @param {AiChat.ApiModel} model
 * @return {Promise<Record<string, any>>}
 */
function llamaModelManage(model) {
	const action = model.status.value === "unloaded" ? "load" : "unload";
	const id = model.id;

	const targetState = action + "ed";

	const models_ = models;

	function listener() {
		if (models_.loading) return;

		if (models_.value.find(model => model.id === id && model.status.value === targetState)) {
			$unwatch(models_, listener);
			_stateChanging.value = "";
			return;
		}

		setTimeout(() => {
			updateModels(true);
		}, 200);
	}

	return jsonFetch(_endpoint.url+"models/"+action, {
		authorization: _endpoint.token,
		body: JSON.stringify({model: id})
	}).then(json => {
		if (!json.success) throw json;
		_stateChanging.value = id;
		updateModels(true);
		$watch(models_, listener, false);
	}).catch(e => {
		showToast(prettyError(e), "error");
	});
}
