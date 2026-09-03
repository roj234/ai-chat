import {config, isLlamaCppBackend, models, setIsLlamaCppBackend, updateModels} from "/src/states.js";
import {$asyncState, $cleanup, $computed, $foreach, $state, $unwatch, $update, $watch} from "unconscious";
import {isLanAddress} from "/common/isLanAddress.js";
import "./llamaCpp.css";
import {prettyError, resolveDBRelativeURL} from "/src/utils/utils.js";
import {jsonFetch} from "/common/openai-api-utils.js";
import {SETTINGS} from "/src/settings.js";
import {showToast} from "/src/components/Toast.js";
import {deepEqual} from "unconscious/common/deepEqual.js";

const _endpoint = $state({});
const _stateChanging = $state("");

/**
 * @type {import("unconscious").ReactivePromise<boolean>}
 */
const isLLaMACppRouter = $asyncState(({url, token}) => {
	setIsLlamaCppBackend(false, false);
	if (!url) return false;
	return jsonFetch(url+"props", { key: token }).then(json => {
		setIsLlamaCppBackend(true, json.build_info.startsWith("bB"));
		return json.role === "router";
	});
}, _endpoint);

$watch(config, () => {
	const url = resolveDBRelativeURL(config.endpoint);
	const value = {
		// remove v1 postfix
		url: isLanAddress(url) ? url.slice(0, url.length-2) : "",
		token: config.accessToken
	};
	if (deepEqual(value, _endpoint.value)) return;
	_endpoint.value = value;
	if (isLLaMACppRouter.error) $update(_endpoint);
});

const updateModelInfo = new IntersectionObserver((entries) => {
	if (isLlamaCppBackend && entries.at(-1).isIntersecting) updateModels(true);
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
			$cleanup(div, () => {updateModelInfo.unobserve(div);});
			return div;
		} else if (isLLaMACppRouter.error.startsWith?.("网络")) {
			return <div>[llama]: 与 llama-server 检测接口 /props 的连接异常<br/>
				<button className={"btn primary"} onClick={() => $update(_endpoint)}>重试</button>
			</div>
		}
	})
});

/**
 *
 * @param {AiChat.ApiModel} model
 * @return {Promise<Record<string, any>>}
 */
const llamaModelManage = model => {
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
		key: _endpoint.token,
		body: JSON.stringify({model: id})
	}).then(json => {
		if (!json.success) throw json;
		_stateChanging.value = id;
		updateModels(true);
		$watch(models_, listener, false);
	}).catch(e => {
		showToast(prettyError(e), "error");
	});
};
