import {SETTINGS} from "/src/settings.js";
import {jsonFetch, prettyError} from "/src/utils/utils.js";
import {config, Shared} from "/src/states.js";
import {provider_presets} from "/media/provider_presets.js";
import {onLoad} from "/src/plugin.js";
import SimpleModal from "../src/components/SimpleModal.jsx";
import {jsonPathOp} from "unconscious/common/json-schema-utils.js";

const EMPTY_WAV = `UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=`;
const EMPTY_BMP = `Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAA/wAAAA==`;
// 你肯定不知道我怎么做出来的
const EMPTY_MP4 = `AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAB9tZGF03ABMYXZjNjEuMy4xMDAAAjBADgEYIAcAAAEybW9vdgAAASp0cmFrAAABIm1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAAAQIVcQAAAAAAPptaW5mAAAA8nN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAAfQAAABZIFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAAfQAAABZIAAAAgc3R0cwAAAAAAAAACAAAAAQAABAAAAAABAAAACAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAABMAAAAEAAAAFHN0Y28AAAAAAAAAAQAAACQ=`;

onLoad((app) => {
	app.append(<datalist id="ac-providers">{Object.entries(provider_presets).map(([k, v]) =>
		<option value={k} label={v.provider}/>
	)}</datalist>);

	const providerInput = Shared.SettingUI.querySelector('[data-id="endpoint"] input');
	providerInput.setAttribute("list", "ac-providers");
});

/**
 *
 * @param {Record<string, any>} body
 * @param flag
 * @return {Promise<*>}
 */
const check = (body, flag) => {
	body.model = config.model;

	if (flag !== 2) {
		const [reasoningPath, reasoningEnabledValue = 'true', reasoningDisabledValue = 'false'] = (config.reasoningPath||"reasoning.enabled").split(",");
		jsonPathOp(body, reasoningPath, "set", JSON.parse(flag === 3 ? reasoningEnabledValue : reasoningDisabledValue));
	}

	let p = jsonFetch(config.endpoint+(config.mode === "chat" ? '/chat/completions' : '/completions'), {
		key: config.accessToken,
		body: JSON.stringify(body)
	}).then(json => {
		const msg = json.choices[0].message;
		if (!msg) throw json;
		return flag === 3 ? msg.content : flag === 2 ? msg : msg.tool_calls || msg.content || msg.reasoning || msg.reasoning_content;
	});

	if (!flag) p = p.catch(() => {});

	return p;
}

const reason_switch_keys = [
	[
		{ chat_template_kwargs: { enable_thinking: false },},
		"chat_template_kwargs.enable_thinking"
	],
	[
		{ reasoning: { enabled: false },},
		""
	],
	[
		{ thinking: { type: "disabled" },},
		"thinking.type,\"enabled\",\"disabled\""
	],
];
const reason_budget_keys = [
	[
		{ thinking_budget_tokens: 1,},
		"thinking_budget_tokens,i"
	],
	[
		{ reasoning: { max_tokens: 1 },},
		"reasoning.max_tokens,i"
	],
];

async function checkModelCapability() {
	const hello = () => {return{
		messages: [{role: "user", content: "Hi"}],
		max_tokens: 1
	}};
	const isThinking = (json) => Object.keys(json).toString().includes("reason");

	let json = await check(hello(), 2);
	let reasoning = '支持';

	foundAny:
	if (isThinking(json)) {
		config.forceThink = null;

		for (const [v, k] of reason_switch_keys) {
			const body = hello();
			Object.assign(body, v);
			json = await check(body, 2);
			if (!isThinking(json)) {
				config.reasoningPath = k;
				break foundAny;
			}
		}

		config.forceThink = true;
		reasoning = '无法关闭';
	} else {
		config.forceThink = false;
		reasoning = '无法开启';
	}

	let reasoningBudget = '不支持';
	if (config.forceThink !== false) {
		config.reasoningEffortPath = '';
		for (const [v, k] of reason_budget_keys) {
			const body = {
				messages: [{role: "user", content: "Compute 375*293"}],
				max_tokens: 50
			}
			Object.assign(body, v);
			json = await check(body, 3);
			if (json) {
				config.reasoningEffortPath = k;
				reasoningBudget = '支持';
				break;
			}
		}

	}

	const get_time_tool = { type: 'function', function: { name: 'get_time', parameters: {
		type: "object",
		properties: {}
	} } };
	const results = await Promise.all([
		// tool call
		check({
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What time is now?" },
				],
			}],
			tools: [get_time_tool],
			tool_choice: get_time_tool,
			max_tokens: 50,
		}),
		// audio
		check({
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What do you hear?" },
					{ type: 'input_audio', input_audio: { data: EMPTY_WAV, format: 'wav' } },
				],
			}],
			max_tokens: 1,
		}),
		// image
		check({
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What do you see?" },
					{ type: 'image_url', image_url: { url: "data:image/bmp;base64,"+EMPTY_BMP } },
				],
			}],
			max_tokens: 1,
		}),
		// video
		check({
			model: config.model,
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What do you see?" },
					{ type: 'input_video', input_video: { data: EMPTY_MP4, format: 'mp4' } },
				],
			}],
			max_tokens: 1,
		}),
		// prefill
		check({
			messages: [
				{ role: 'user', content: 'Hi' },
				{ role: 'assistant', content: 'My name is not ' },
			],
			max_tokens: 20,
		}),
		// logprobs
		check({
			messages: [
				{ role: 'user', content: 'Hi' },
			],
			logprobs: true,
			max_tokens: 1,
			top_logprobs: 5
		}),
		// json object
		check({
			model: config.model,
			messages: [{ role: 'user', content: 'What is your name? Use ```json\nresponse```.' }],
			response_format: { type: 'json_object', },
			max_tokens: 50,
		}),
		// json schema
		check({
			model: config.model,
			messages: [{ role: 'user', content: 'What is your name?' }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: '',
					schema: { type: 'object',
						properties: {
							my_name_is: {type: 'string'},
						},
						required: ['my_name_is'],
						additionalProperties: false
					},
				},
			},
			max_tokens: 50,
		}),
		check({
			model: config.model,
			messages: [{ role: 'user', content: 'What is your name?' }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: '',
					schema: {
						type: 'object',
						oneOf: [{
							properties: {
								next_field: { 'const': 'name' },
								name: {type: 'string'},
							},
							required: ['next_field', 'name']
						}, {
							properties: {
								next_field: { 'const': 'desc' },
								desc: {type: 'string'},
							},
							required: ['next_field', 'desc']
						}]
					},
				},
			},
			max_tokens: 50,
		}),
	]);

	const isJson = (text) => {
		try {
			JSON.parse(text);
			return true;
		} catch {
			return false;
		}
	}

	const title = "工具,音频,图像,视频,预填充,logprobs,JSON对象,JSON Schema (严格),JSON Schema (完全),思考开关,思考预算".split(',');
	const modalities = [];
	if (results[0]) modalities.push("tool");
	if (results[1]) modalities.push("audio");
	if (results[2]) modalities.push("image");
	if (results[3]) modalities.push("video");
	config.modalities = modalities;
	config.canPrefill = results[4]?.startsWith("My name is not ");

	if (isJson(results[8])) config.jsonSupport = 3;
	else if (isJson(results[7])) config.jsonSupport = 2;
	else if (isJson(results[6])) config.jsonSupport = 1;
	else config.jsonSupport = 0;

	Shared.SettingUI.sync();

	results.push(reasoning);
	results.push(reasoningBudget);

	return results.map((item, i) => title[i]+": "+(i===4?config.canPrefill:i>=9?item:((i>=6?isJson(item):item)?"支持":"不支持"))).join('\n');
}

SETTINGS.push({
	name: "测试",
	type: "element",
	_tab: "model",
	element: <div className={"choice-scroll"}>
		<button className={"btn primary"} onClick={({target}) => {
			target.disabled = true;

			const mode = config.mode !== "chat";
			check(mode ? {
				prompt: "Hi ",
				max_tokens: 1,
			} : {
				messages: [{role: "user", content: "Hi"}],
				max_tokens: 1,
			}, 1).then(() => {
				target.textContent = "成功";
				SimpleModal({
					title: "连接成功",
					message: "如果需要测试模型能力（因为没有配置模板可用）请点击确认",
					onConfirm() {
						checkModelCapability().then((res) => {

							SimpleModal({
								title: "能力测试完成",
								message: "数据已经保存\n"+res,
								onConfirm: null
							})
						});
					}
				})
			}).catch(err => {
				console.error(err);
				err = prettyError(err);
				SimpleModal({
					title: "连接失败",
					message: err,
					onConfirm: null
				})
				target.textContent = "失败";
			}).finally(() => {
				target.disabled = false;
			});
		}}>测试
		</button>
	</div>
});