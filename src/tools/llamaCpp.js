import {config, isLlamaCppBackend, models, setIsLlamaCppBackend, updateModels} from "../states.js";
import {$asyncState, $computed, $disposable, $foreach, $state, $unwatch, $update, $watch} from "unconscious";
import {isLanAddress} from "./isLanAddress.js";
import "./llamaCpp.css";
import {jsonFetch, prettyError} from "../utils.js";
import {SETTING_UI_CONFIG} from "../setting-ui.js";
import {showToast} from "../components/Toast.js";
import {isEqual} from "../../vendor/equals.js";

const _endpoint = $state({});
const _stateChanging = $state("");

/**
 * @type {import("unconscious").ReactivePromise<boolean>}
 */
const isLLaMACppRouter = $asyncState(({url, token}) => {
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

SETTING_UI_CONFIG.push({
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
