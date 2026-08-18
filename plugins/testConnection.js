import {prettyError, resolveDBRelativeURL} from "/src/utils/utils.js";
import {config} from "/src/states.js";
import {provider_presets} from "/media/provider_presets.js";
import {DI_settings, onLoad} from "/src/hooks.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {jsonEval, jsonGet} from "unconscious/common/json-schema-utils.js";
import {applyDelta, sseFetch} from "/common/openai-api-utils.js";
import {highlightJsonLike} from "/src/markdown/highlight.js";
import {AsyncButton} from "/src/components/AsyncButton.jsx";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";

const EMPTY_WAV = `UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=`;
const EMPTY_BMP = `Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAATCwAAEwsAAAAAAAAAAAAA/wAAAA==`;
// 你肯定不知道我怎么做出来的
const EMPTY_MP4 = `AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAB9tZGF03ABMYXZjNjEuMy4xMDAAAjBADgEYIAcAAAEybW9vdgAAASp0cmFrAAABIm1kaWEAAAAgbWRoZAAAAAAAAAAAAAAAAAAAH0AAAAQIVcQAAAAAAPptaW5mAAAA8nN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAAAfQAAAAAAANmVzZHMAAAAAA4CAgCUAAQAEgICAF0AVAAAAAAAfQAAABZIFgICABRWIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAAfQAAABZIAAAAgc3R0cwAAAAAAAAACAAAAAQAABAAAAAABAAAACAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAgAAAAEAAAAcc3RzegAAAAAAAAAAAAAAAgAAABMAAAAEAAAAFHN0Y28AAAAAAAAAAQAAACQ=`;

onLoad((app) => {
	const DATALIST_ID = 'DL-providers';
	const owner = DI_settings.byId('endpoint');
	owner.append(<datalist id={DATALIST_ID}>
		{Object.entries(provider_presets).map(([k, v]) =>
			<option value={k} label={v}/>
		)}
	</datalist>);
	owner.children[0].setAttribute("list", DATALIST_ID);
});

let streamFlag;

/**
 *
 * @param {Record<string, any>} body
 * @param {number=} flag
 * @param {RegExp=} err1
 * @return {Promise<*>}
 */
const test = async (body, flag, err1) => {
	body.model = config.model;
	if (streamFlag) body.stream = true;
	if (!body.max_completion_tokens) body.max_completion_tokens = 16;

	if (flag !== 2) {
		const [reasoningPath, reasoningEnabledValue = 'true', reasoningDisabledValue = 'false'] = (config.reasoningPath||"reasoning/enabled").split(",");
		jsonEval(body, reasoningPath, "set", JSON.parse(flag === 3 ? reasoningEnabledValue : reasoningDisabledValue));
	}

	const additionalBody = config.additionalBody;
	if (additionalBody) Object.assign(body, additionalBody);

	let completion;
	let p = sseFetch(resolveDBRelativeURL(config.endpoint)+(config.mode === "chat" ? '/chat/completions' : '/completions'), {
		key: config.accessToken,
		body: JSON.stringify(body)
	}, (chunk, type) => {
		if (type === '\0') completion = chunk;
		else if (type == null) {
			if (!completion) completion = {};

			const {choices, ...rest} = chunk;
			completion.choices = applyDelta(completion.choices, choices);
			Object.assign(completion, rest);
		}
	}).then(() => {
		let msg = completion?.choices?.[0];
		if (!msg) throw completion ? JSON.stringify(completion) : "Null Response";

		if (typeof flag === 'string') return err1(jsonGet(msg, flag))
		msg = msg.delta || msg.message;
		if (!msg) throw completion;
		return flag === 3 ? msg.content : flag === 2 ? msg : msg.tool_calls || msg.content || msg.reasoning || msg.reasoning_content;
	});

	if (!flag) p = p.catch((err) => {
		if (err1 && String(err).match(err1)) return true;
	});

	return p;
}

const reason_switch_keys = [
	[
		{ chat_template_kwargs: { enable_thinking: false },},
		"/chat_template_kwargs/enable_thinking"
	],
	[
		{ reasoning: { enabled: false },},
		""
	],
	[
		{ thinking: { type: "disabled" },},
		"/thinking/type,\"enabled\",\"disabled\""
	],
	[
		{ enable_thinking: false,},
		"/enable_thinking"
	],
];
const reason_budget_keys = [
	[
		{ thinking_budget_tokens: 1,},
		"thinking_budget_tokens,i"
	],
	[
		{ thinking_budget: 1,},
		"thinking_budget,i"
	],
	[
		{ reasoning: { max_tokens: 1 },},
		"reasoning.max_tokens,i"
	],
];

const prefill_keys = [
	"", "prefix", "partial"
];

async function checkModelCapability() {
	const hello = () => {return{
		messages: [{role: "user", content: "Hi"}]
	}};
	const isThinking = (json) => Object.keys(json).filter(key => json[key]).toString().includes("reason") || json.content.startsWith("<think>");

	let json = await test(hello(), 2);
	let reasoning = '支持';

	foundAny:
	if (isThinking(json)) {
		config.forceThink = null;

		for (const [v, k] of reason_switch_keys) {
			const body = hello();
			Object.assign(body, v);
			json = await test(body, 2);
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
				messages: [{role: "user", content: "Compute 375*293"}]
			}
			Object.assign(body, v);
			json = await test(body, 3);
			if (json) {
				config.reasoningEffortPath = k;
				reasoningBudget = '支持';
				break;
			}
		}
	}

	const checkPrefill = async () => {
		const CHECK = '```json\n{"greeting": ';
		for (const k of prefill_keys) {
			const body = {
				messages: [
					{ role: 'user', content: 'Hi' },
					{ role: 'assistant', content: CHECK, [k]: true },
				],
				max_completion_tokens: 32
			}
			try {
				let content = await test(body);
				if (content && (content.startsWith(CHECK) || content.trim()[0] === ("\"") || content.endsWith("```"))) {
					config.prefillPath = k;
					return config.canPrefill = true;
				}
			} catch {}
		}
		config.prefillPath = '';
		return config.canPrefill = false;
	};

	const get_time_tool = { type: 'function', function: { name: 'get_time', parameters: {
		type: "object",
		properties: {}
	} } };
	const results = await Promise.all([
		// tool call
		test({
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What time is now?" },
				],
			}],
			tools: [get_time_tool],
			//tool_choice: get_time_tool,
			max_completion_tokens: 50,
		}, 'message/tool_calls/0/function/name', (fn) => fn === 'get_time'),
		// audio
		test({
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What do you hear?" },
					{ type: 'input_audio', input_audio: { data: EMPTY_WAV, format: 'wav' } },
				],
			}],
		}, 0, /size|duration|time/i),
		// image
		test({
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What do you see?" },
					{ type: 'image_url', image_url: { url: "data:image/bmp;base64,"+EMPTY_BMP } },
				],
			}],
		}, 0, /size|1x1|width/i),
		// video
		test({
			model: config.model,
			messages: [{
				role: 'user',
				content: [
					{ type: "text", text: "What do you see?" },
					{ type: 'input_video', input_video: { data: EMPTY_MP4, format: 'mp4' } },
				],
			}],
		}, 0, /size|1x1|duration|time|width/i),
		// prefill
		checkPrefill(),
		// logprobs
		test({
			messages: [
				{ role: 'user', content: 'Hi' },
			],
			logprobs: true,
			top_logprobs: 2
		}, '/logprobs/content/0/logprob', (fn) => typeof fn === 'number'),
		// json object
		test({
			model: config.model,
			messages: [{ role: 'user', content: 'What is your name? Use ```json\n{ "name": ... }\n```.' }],
			response_format: { type: 'json_object', },
			max_completion_tokens: 50,
		}),
		// json schema
		test({
			model: config.model,
			messages: [{ role: 'user', content: 'What is your name?' }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'my_schema',
					schema: { type: 'object',
						properties: {
							my_name_is: {type: 'string'},
						},
						required: ['my_name_is'],
						additionalProperties: false
					},
				},
			},
			max_completion_tokens: 50,
		}),
		test({
			model: config.model,
			messages: [{ role: 'user', content: 'What is your name?' }],
			response_format: {
				type: 'json_schema',
				json_schema: {
					name: 'my_schema',
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
			max_completion_tokens: 50,
		}),
	]);

	const isJson = (text, n) => {
		try {
			return null != JSON.parse(text)[n];
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

	config.jsonSupport = 0;
	if ((results[6] = isJson(results[6], 'name'))) config.jsonSupport = 1;
	if ((results[7] = isJson(results[7], 'my_name_is'))) config.jsonSupport = 2;
	if ((results[8] = isJson(results[8], 'next_field'))) config.jsonSupport = 3;

	DI_settings.sync();

	results.push(reasoning);
	results.push(reasoningBudget);

	console.log(results);
	return results.map((item, i) => title[i]+": "+(i>=9?item:(item?"支持":"不支持"))).join('\n');
}

onLoad(() => {
	const target = DI_settings.byId("mode");
	target.append(<div className={"spacer"}></div>)
	target.append(<AsyncButton pendingText={"测试中"} okText={"成功"} failText={"失败"} className={"btn primary"} onClick={(target) => new Promise((resolve, reject) => {
		streamFlag = false;
		const isLegacyCompletionMode = config.mode !== "chat";
		const check = () => {
			test(isLegacyCompletionMode ? {
				prompt: "Hi",
			} : {
				messages: [{role: "user", content: "Hi"}],
			}, 2).then((msg) => {
				if (isLegacyCompletionMode) return resolve();

				const {content, ...rest} = msg;

				SimpleModal({
					title: "连接成功",
					message: <>响应：
						{renderMarkdownToElement(<div className={"md"} />, content)}
						<div dangerouslySetInnerHTML={highlightJsonLike(rest)} />
						{`点击确认测试模型能力并自动配置软件
潜在花费：输入 300-3000 token (根据模型能力), 输出 ~300 token`}</>,
					onConfirm() {
						checkModelCapability().then((res) => {
							SimpleModal({
								title: "能力探测完成",
								message: "数据已经保存\n" + res,
								onConfirm: null,
								onCancel: resolve
							})
						});
					},
					onCancel: resolve
				})
			}).catch(err => {
				console.error(err);
				err = prettyError(err);
				if (streamFlag) {
					SimpleModal({
						title: "连接失败",
						message: <div dangerouslySetInnerHTML={highlightJsonLike(err)}/>,
						onCancel: reject
					});
				} else {
					SimpleModal({
						title: "连接失败\n但不排除是提供商不支持非流响应或过短的max_completion_tokens",
						message: <div dangerouslySetInnerHTML={highlightJsonLike(err)}/>,
						confirmMessage: "以兼容模式重试",
						onConfirm() {
							streamFlag = true;
							check();
						},
						onCancel: reject
					})
				}
			});
		};
		check();
	})}>测试</AsyncButton>);
})