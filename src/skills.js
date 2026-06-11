import {config, messages, onConversationBeforeunload, onConversationLoaded, selectedConversation} from "./states.js";
import {$state, $update, debugSymbol, unconscious} from "unconscious";
import {loadingBlock, prettyError} from "./utils/utils.js";

import "./skills.css";
import {updateMessageUI} from "./components/MessageList.jsx";
import {compileSchema, jsonPathOp} from "unconscious/common/json-schema-utils.js";
import {onLoad} from "./plugin.js";
import {COMMAND_REGISTRY} from "./commands.js";
import {showToast} from "./components/Toast.js";

export const TOOL_NAME = debugSymbol("TOOL_NAME");
const TOOL_PARAM = debugSymbol("TOOL_PARAM");

/**
 * @type {Record<string, string | function(): string>}
 */
export const PLACEHOLDERS = {};

onLoad(() => {
	COMMAND_REGISTRY.tools = [
		(args, params, element) => {
			element.value = "/### 当前注册的工具\n"+(Object.entries(optionalTools).map(([k, v]) => "名称："+k+"\n描述："+v.description+"\n工具："+v.allowedTools+"\n隐藏："+v.hidden).join("\n\n"));
			element.dispatchEvent(new InputEvent("input"));
		},
		"列出可用的工具"
	];
	COMMAND_REGISTRY.use_tools = [
		async (args, params, element) => {
			const conv = unconscious(selectedConversation);
			if (!conv) throw "不在对话中";
			await toolScriptRegistry.use.script({modules: args}, {[TOOL_NAME]:"use"}, conv);
			conv.activatedModules.add("use");
			showToast("已启用，注意这将禁用模型自行激活工具模块的能力");
		},
		"启用工具组"
	];
	COMMAND_REGISTRY.revoke_tools = [
		async (args, params, element) => {
			const conv = unconscious(selectedConversation);
			if (!conv) throw "不在对话中";
			await toolScriptRegistry.use.undo({newModules: args}, conv);
			showToast("已禁用");
		},
		"禁用工具组"
	];
});

/**
 * 常开工具
 * @type {OpenAI.Tool[]}
 */
const defaultTools = [];
/**
 * 工具/技能摘要，在调用后激活其它工具或返回技能内容
 * @type {Record<string, {description: string, allowedTools: string[], skill?: string, hidden: boolean | 'manual', systemPrompt: string}>}
 */
const optionalTools = {};
/**
 * 根据工具摘要按需激活的工具元数据
 * @type {Record<string, OpenAI.Tool>}
 */
const tools = {};
/**
 * 工具脚本，所有（无论是skills还是tools）调用后执行的代码都在这里
 * @type {Record<string, AiChat.FunctionToolImpl>}
 */
export const toolScriptRegistry = {};

/**
 * 工具返回内容对象（通过这个接口可以返回图片、音频(WIP)等）
 * @type {OpenAI.ContentPart}
 */
export class ContentPart {
	constructor() {
		this.content = [];
	}

	text(text) {
		this.content.push({type: "text", text});
		return this;
	}
	image(image) {
		this.content.push({type: "image_url", image_url: {url: image}});
		return this;
	}
}

export {jsonPathOp} from "unconscious/common/json-schema-utils.js";


export const set_title_body = {
	type: "function",
	function: {
		name: "set_title",
		description: "根据聊天内容设置对话标题，每当用户开始一个新话题时，请调用该工具为本次对话命名",
		parameters: {
			type: "object",
			properties: {
				title: {
					type: "string",
					minLength: 4,
					maxLength: 20
				}
			},
			required: ["title"]
		},
	}
};

toolScriptRegistry["set_title"] = {
	name: "set_title",
	default: true,
	script({title}, response, globalStorage) {
		globalStorage.title = title;

		const last = messages.at(-1);
		if (!last.content) messages.pop();
		else {
			delete last.tool_calls;
			delete last.tool_responses;
		}

		$update(selectedConversation);
	}
};

const use_isRevoked = debugSymbol("use_isRevoked");

toolScriptRegistry["use"] = {
	name: "use",
	reentrant: true,
	default: true,
	async script({modules}, response, globalStorage) {
		let {allowedTools, activatedModules} = globalStorage;
		if (!allowedTools) {
			allowedTools = new Set;
			activatedModules = new Set;
			globalStorage.allowedTools = allowedTools;
			globalStorage.activatedModules = activatedModules;
		}

		this.undo(response, globalStorage);

		const newToolNames = [];

		response.newModules = modules;
		response.newTools = newToolNames;

		for (const moduleName of modules) {
			let {allowedTools: allowedToolsArr, onActivated: dynamicCallback} = optionalTools[moduleName];

			if (dynamicCallback) {
				allowedToolsArr = await dynamicCallback(allowedToolsArr);
				allowedToolsArr = allowedToolsArr.map(t => t.name || t);
			}

			activatedModules.add(moduleName);
			allowedToolsArr.forEach(name => {
				if (!allowedTools.has(name)) {
					allowedTools.add(name);
					newToolNames.push(name);
				}
			});
		}

		if (response[TOOL_NAME].startsWith("use:skill:")) {
			response.isSkill = true;
			return optionalTools[modules[0]].skill;
		}

		if (response[use_isRevoked]) response[use_isRevoked].value = false;
		return "You can use these tools now: "+newToolNames.join(", ");
	},

	renderer(context) {
		if (context.success === false) return;
		if (!context.newTools) return loadingBlock("等待调用结果……");

		const isRevoked = !context.content.startsWith("You");
		if (!context[use_isRevoked]) context[use_isRevoked] = $state(isRevoked);

		return (
			<div className={`skills`} class:revoked={() => context[use_isRevoked].value}>
				<div className="tool-label-group">
					<span>⚡ 获得新能力:</span>
					{context.newTools.map(t => (
						<span key={t} className="tool-tag">{t}</span>
					))}
				</div>

				<span style={{flex: 1}}></span>

				{() => context[use_isRevoked].value ? (
					<div className="revoked-status tool-label-group">
						<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
						已撤销
					</div>
				) : (
					<button className="revoke-btn" onClick={() => {
						context[use_isRevoked].value = true;
						context.content = "Not allowed";
						this.undo(context, selectedConversation);
						$update(messages);
					}}>
						撤销
					</button>
				)}
			</div>
		);
	},
	undo({newModules}, {allowedTools, activatedModules}) {
		if (!allowedTools || !newModules) return;

		allowedTools.clear();
		for (const moduleName of newModules) {
			activatedModules.delete(moduleName);
		}
		activatedModules.forEach(name => optionalTools[name]?.allowedTools.forEach(name => allowedTools.add(name)));
	}
};

/**
 *
 * @param {{allowedTools: Set<string>, activatedModules: Set<string>}} conversation
 * @param {boolean} allowNewSkills
 * @return {Promise<[OpenAI.Tool[], string]>}
 */
export const getTools = async (conversation, allowNewSkills) => {
	const {allowedTools, activatedModules} = conversation;

	// 隐藏工具必须通过系统提示开启
	let usableOptTools = Object.keys(optionalTools).filter(name => !optionalTools[name].hidden);
	let usableDefTools = defaultTools;

	let systemPrompt = [];
	if (activatedModules) {
		const disableAll = activatedModules.has('*');
		if (disableAll) {
			usableOptTools = usableDefTools = [];
		} else {
			usableOptTools = usableOptTools.filter(name => !activatedModules.has(name));
			usableDefTools = usableDefTools.filter(tool => !activatedModules.has(tool.function.name));
		}
		for (const name of activatedModules) {
			let prompt = optionalTools[name]?.systemPrompt;
			if (prompt) {
				if (typeof prompt === "function") prompt = await prompt();
				systemPrompt.push(prompt);
			}
		}
	}

	let tools_ = [];
	if (usableOptTools.length && !activatedModules?.has("use") && allowNewSkills) {
		tools_.push({
			type: "function",
			function: {
				name: "use",
				description: "Activate one or more capability modules needed for the current task. Do not call this if request can be answered directly or just topic related to it.\n\n" + (
					usableOptTools.map(name => name+": "+optionalTools[name].description).join("\n")
				),
				parameters: {
					type: "object",
					properties: {
						modules: {
							type: "array",
							minItems: 1,
							items: { enum: usableOptTools },
						}
					},
					required: ["modules"]
				},
			}
		});
	}

	tools_.push(...usableDefTools);

	if (allowedTools) {
		for (const name of allowedTools) {
			const tool1 = tools[name];
			if (!tool1) throw '工具 '+name+' 不存在';
			tools_.push(tool1);
		}
	}
	return [tools_, systemPrompt.join("\n\n")];
};

const convertToCamelCase = str => str.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());

/**
 *
 * @param {string} content
 * @return {[{}, string]}
 */
export const parseSkillMetadata = content => {
	const metadata = {};

	if (!content.startsWith("---\n")) return [metadata, content];
	const end = content.indexOf("\n---", 3);
	if (end < 0) return [metadata, content];

	const body = content.slice(end + 4).trim();

	content.slice(4, end).trim().split("\n")
		.filter(v => v)
		.map(v => {
			const index = v.indexOf(':');
			return [v.slice(0, index).trim(), v.slice(index + 1).trim()];
		})
		.forEach(([k, v]) => {
			k = convertToCamelCase(k);
			if (k.endsWith("Tools")) v = v.split(" ");
			metadata[k] = v;
	});

	return [metadata, body];
};

const NO_PARAMETERS = {
	"type": "object",
	"properties": {}
};

/**
 *
 * @param {string} text
 */
export const registerSkill = text => {
	const [skill, content] = parseSkillMetadata(text);
	if (!skill) throw new Error("SKILL.md format error");

	skill.name = "skill:"+skill.name;

	if (skill.name in toolScriptRegistry)
		throw new Error("同名工具已存在？");

	/*optionalTools[skill.name] = {
		description: skill.description,
		allowedTools: skill['allowed-tools'],
		skill: content
	};*/
	defaultTools.push({
		"type": "function",
		"function": {
			name: skill.name,
			description: skill.description,
			parameters: NO_PARAMETERS
		}
	});
	toolScriptRegistry[skill.name] = {
		script() {return content.trim();},
		default: true,
	};
};

/**
 * @param {AiChat.FunctionTool} tool
 * @return {OpenAI.Tool}
 */
const registerTool = tool => {
	const {name, description, parameters = NO_PARAMETERS, ...rest} = tool;
	if (!rest.script) throw new Error("Missing script for tool " + name);

	if (name in toolScriptRegistry) {
		if (toolScriptRegistry[name].script === rest.script) return;
		throw new Error("同名工具已存在？");
	}

	parameters.additionalProperties = false;
	compileSchema(parameters, true);
	toolScriptRegistry[name] = rest;
	rest.parameters = parameters;
	return {
		type: "function",
		function: {name, description, parameters}
	};
};

/**
 * 注册按需启用的工具
 * @param {string|undefined} name
 * @param {string} description
 * @param {Partial<AiChat.FunctionTool>[]} toolDefs
 * @param {Partial<{
 *     onActivated: function(): AiChat.FunctionTool[],
 *     hidden: boolean | 'manual',
 *     systemPrompt: string
 * }>} extra
 */
export const registerTools = (name, description, toolDefs, {onActivated, hidden, systemPrompt} = {}) => {
	const toolNames = [];
	for (const toolDef of toolDefs) {
		const tool = registerTool(toolDef);
		if (tool) tools[toolDef.name] = tool;
		toolNames.push(toolDef.name);
	}

	optionalTools[name] = {
		description,
		allowedTools: toolNames,
		onActivated,
		hidden,
		systemPrompt
	};
};

/**
 * 注册默认启用的工具
 * @param {AiChat.FunctionTool[]} tools
 */
export const registerDefaultTools = tools => {
	for (const tool of tools) {
		tool.default = true;
		defaultTools.push(registerTool(tool));
	}
};

const CONV_REACTIVE_MAP = debugSymbol("CONV_REACTIVE_MAP");

onConversationLoaded((conv, msg) => redoToolCalls(conv, msg, 0));
onConversationBeforeunload((conv) => delete conv[CONV_REACTIVE_MAP]);

/**
 *
 * @param {AiChat.AssistantMessage} response
 * @param {AiChat.Conversation} globalStorage
 * @param {true|number|null=null} forceRerun
 * @param {boolean=} allowUnsafe
 * @return {Promise<boolean>}
 */
export const runTools = async ({tool_calls, tool_responses}, globalStorage, forceRerun, allowUnsafe) => {
	let autoNext = true;

	const callTool = async i => {
		const tc = tool_calls[i];
		let msg = tool_responses[i];
		let {name} = tc.function;

		if (msg?.success != null) {
			if (forceRerun !== i) return;
			if (msg.success) toolScriptRegistry[name].undo?.(msg, globalStorage, tc);
		}
		msg = tool_responses[i] = {};

		msg[TOOL_NAME] = name;
		msg.time = Date.now();

		try {
			const parameters = getToolParameters(msg, tc);

			const fn = toolScriptRegistry[name];
			const {allowedTools} = globalStorage;
			if (!(fn && (fn.default || allowedTools?.has(name)))) {
				throw fn
					? 'Call \'use\' to activate this tool.'
					: optionalTools[name]
						? 'This is a tool group, not real tool, call use(['+JSON.stringify(name)+']) to activate'
						: 'Tool not exist';
			}

			let interactive = fn.interactive;
			if (interactive) {
				/*if (typeof interactive === "function") {
					interactive = interactive(parameters);
				}*/
				if (interactive === "secure") {
					if (!config.permitAllTools && !selectedConversation.grantedTools?.has(name)) {
						autoNext = false;
						if (forceRerun === true || (forceRerun === i && !allowUnsafe)) {
							throw "User doesn't permit this call";
						}

						if (forceRerun !== i) {
							delete msg.time;
							return;
						}
					}
				} else {
					autoNext = false;
				}
			}

			let result = fn.script(parameters, msg, globalStorage);
			if (result instanceof Promise) {
				$update(updateMessageUI);
				result = await result;
			}
			if (typeof result !== "string") result = result instanceof ContentPart ? result.content : JSON.stringify(result);
			if (result !== undefined) { // checks undefined
				msg.success = true;
				msg.content = result;
			}
		} catch (e) {
			console.error(e);
			msg.success = false;
			msg.content = prettyError(e);
			autoNext = false;
		}
		msg.time = Date.now();
	};

	if (typeof forceRerun === "number") await callTool(forceRerun);
	else for (let i = 0; i < tool_calls.length; i++) await callTool(i);

	return autoNext;
};

/**
 * 撤销工具调用
 * @param {AiChat.Conversation} global
 * @param {AiChat.AssistantMessage[]} messages
 * @param {number} first
 */
export const undoToolCalls = (global, messages, first) => {
	for (let i = messages.length - 1; i >= first; i--) {
		const {tool_calls, tool_responses} = messages[i];
		if (tool_responses) {
			for (let j = tool_responses.length - 1; j >= 0; j--) {
				let toolResponse = tool_responses[j];
				try {
					toolScriptRegistry[toolResponse[TOOL_NAME]].undo?.(toolResponse, global, tool_calls[j]);
				} catch (e) {
					console.error(e);
				}
			}
		}
	}
};

/**
 * 重做工具调用
 * @param {AiChat.Conversation} global
 * @param {AiChat.AssistantMessage[]} messages
 * @param {number} first
 * @param {boolean=} includeTrue
 */
export const redoToolCalls = (global, messages, first, includeTrue) => {
	for (let i = first; i < messages.length; i++) {
		const {tool_calls, tool_responses} = messages[i];
		if (tool_calls) {
			for (let i = 0; i < tool_calls.length; i++) {
				const {name, arguments: args} = tool_calls[i].function;

				const impl = toolScriptRegistry[name];
				const toolResponse = tool_responses?.[i];
				if (toolResponse) toolResponse[TOOL_NAME] = name;

				const reentrant = impl?.reentrant;
				if (reentrant && (includeTrue || reentrant === 'stateless')) {
					try {
						impl.script(JSON.parse(args), toolResponse, global);
					} catch (e) {
						console.error("Redo tool "+name, e);
					}
				}
			}
		}
	}
};

/**
 *
 * @param {string} system_prompt
 */
export const setSystemPrompt = system_prompt => {
	if (system_prompt) {
		if (messages[0].role === "system") {
			messages[0].content = system_prompt;
		} else {
			messages.unshift({
				role: "system",
				time: Date.now(),
				content: system_prompt
			});
		}
	} else if (messages[0].role === "system") {
		messages.shift();
	}
};

/**
 * 获取缓存的解析的工具参数对象
 * @param {AiChat.ToolResponse} response
 * @param {OpenAI.ToolCall} toolcall
 * @return {Record<string, any>}
 */
export const getToolParameters = (response, toolcall) => {
	let parsed = response[TOOL_PARAM];
	if (!parsed) parsed = response[TOOL_PARAM] = JSON.parse(toolcall.function.arguments);
	return parsed;
}

/**
 * 在全局存储上挂载一个响应式对象
 * @param {AiChat.Conversation} conv
 * @param {string} name
 * @return {import("unconscious").Reactive<void>}
 */
export const createStateListener = (conv, name) => {
	let map = conv[CONV_REACTIVE_MAP];
	if (!map) map = conv[CONV_REACTIVE_MAP] = new Map;

	let result = map.get(name);
	if (!result) map.set(name, result = $state());
	return result;
}