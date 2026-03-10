import {config, messages, selectedConversation} from "./states.js";
import {$state, $update, $watch, debugSymbol} from "unconscious";
import {loadingBlock, prettyError} from "./utils.js";

import "./skills.css";
import {updateMessageUI} from "./components/MessageList.jsx";


/**
 *
 * @type {import("unconscious").Reactive<Record<string, any>>}
 */
export const volatileEnvironment = $state({});

/**
 * 常开工具
 * @type {OpenAI.Tool[]}
 */
const defaultTools = [];
/**
 * 工具/技能摘要，在调用后激活其它工具或返回技能内容
 * @type {Record<string, {description: string, allowedTools: string[], skill?: string, hidden: boolean}>}
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

/**
 *
 * @param {string} path
 * @return {string[]}
 */
export const parseJsonPath = (path) => {
	const keys = path.split('.');
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (key.endsWith("]")) {
			const j = key.indexOf("[");
			const pre = key.substring(0, j);
			const post = key.substring(j+1, key.length-1);
			keys.splice(i, 1, pre, post);
			i++;
		}
	}
	return keys;
}

/**
 * 辅助函数：解析路径并操作对象
 * @param {Object} obj
 * @param {string|string[]} path
 * @param {'set' | 'add'| 'append' | 'merge' | 'delete' | 'get'} action
 * @param {any=} value
 * @return {{value: any, undo: any}}
 */
export const jsonPathOp = (obj, path, action, value) => {
	const keys = Array.isArray(path) ? path : parseJsonPath(path);

	let current = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		if (!current[keys[i]]) {
			if (action === "delete") return {value: false};
			if (action === "get") return {};

			current[keys[i]] = {};
		}
		current = current[keys[i]];
	}
	const lastKey = keys[keys.length - 1];

	let container = current[lastKey];
	let undo = container;

	switch (action) {
		case 'get': return {value: container};
		case 'set': container = value; break;
		case 'add': container = Number(container || 0) + Number(value); break;
		case 'append':
			if (!Array.isArray(container)) {
				if (container) throw new Error("值 "+path+" 已存在且不是数组！");
				container = [];
			}

			undo = container.length;
			if (Array.isArray(value)) container.push(...value);
			else container.push(value);
		break;
		case 'merge': container = { ...container, ...value }; break;
		case 'delete': {
			if (Array.isArray(current)) {
				undo = current.splice(parseInt(lastKey), 1);
				return {
					undo: {
						_isArray: true,
						value: undo
					},
					value: undo
				}
			} else {
				undo = current[lastKey];
				return {
					undo,
					value: delete current[lastKey]
				};
			}
		}
	}

	current[lastKey] = container;
	return {
		undo,
		value: container
	};
};


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

	autorun: "on_import",
	async script({modules}, response, globalStorage) {
		let {allowedTools, activatedModules} = globalStorage;
		if (!allowedTools) {
			allowedTools = new Set;
			activatedModules = new Set;
			globalStorage.allowedTools = allowedTools;
			globalStorage.activatedModules = activatedModules;
		}

		this.removed(response, globalStorage);

		const newToolNames = [];
		for (const moduleName of modules) {
			activatedModules.add(moduleName);

			let {allowedTools: allowedToolsArr, onActivated: dynamicCallback} = optionalTools[moduleName];

			if (dynamicCallback) {
				allowedToolsArr = dynamicCallback(allowedToolsArr);
				if (allowedToolsArr instanceof Promise) allowedToolsArr = await allowedToolsArr;
				allowedToolsArr = allowedToolsArr.map(t => t.name || t);
			}

			allowedToolsArr.forEach(name => {
				if (!allowedTools.has(name)) {
					allowedTools.add(name);
					newToolNames.push(name);
				}
			});
		}

		response.newModules = modules;
		response.newTools = newToolNames;

		if (response.tool_name.startsWith("use:skill:")) {
			response.isSkill = true;
			return optionalTools[modules[0]].skill;
		}

		if (response[use_isRevoked]) response[use_isRevoked].value = false;
		return "You can use these tools now: "+newToolNames.join(", ");
	},

	renderer(context) {
		if (context.success === false) return;
		if (!context.newTools) return loadingBlock("等待异步回调……");

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
						this.removed(context, selectedConversation);
						$update(messages);
					}}>
						撤销
					</button>
				)}
			</div>
		);
	},
	removed(message, {allowedTools, activatedModules}) {
		if (!allowedTools || !message.newModules) return;

		allowedTools.clear();
		for (const moduleName of message.newModules) {
			activatedModules.delete(moduleName);
		}
		activatedModules.forEach(name => optionalTools[name]?.allowedTools.forEach(name => allowedTools.add(name)));
	}
};

/**
 *
 * @param {{allowedTools: Set<string>, activatedModules: Set<string>}} conversation
 */
export function getTools(conversation) {
	const {allowedTools, activatedModules} = conversation;

	// 隐藏工具必须通过系统提示开启
	let usableOptTools = Object.keys(optionalTools).filter(name => !optionalTools[name].hidden);
	let usableDefTools = defaultTools;

	if (activatedModules) {
		const disableAll = activatedModules.has('*');
		if (disableAll) {
			usableOptTools = usableDefTools = [];
		} else {
			usableOptTools = usableOptTools.filter(name => !activatedModules.has(name));
			usableDefTools = usableDefTools.filter(tool => !activatedModules.has(tool.function.name));
		}
	}

	let tools_ = [];
	if (usableOptTools.length && !activatedModules?.has("use")) {
		tools_.push({
			type: "function",
			function: {
				name: "use",
				description: "按需激活特定功能，在你明确需要执行特定任务前，请勿调用此工具。\n\n" + (
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
	if (allowedTools) tools_.push(...allowedTools.values().map(name => tools[name]));
	return tools_;
}

function convertToCamelCase(str) {
	return str.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
}

/**
 *
 * @param {string} content
 * @return {[{}, string]}
 */
export function parseSkillMetadata(content) {
	const metadata = {};

	if (!content.startsWith("---\n")) return [metadata, content];
	const end = content.indexOf("\n---", 3);
	if (end < 0) return [metadata, content];

	const body = content.substring(end + 4).trim();

	content.substring(4, end).trim().split("\n")
		.filter(v => v)
		.map(v => {
			const index = v.indexOf(':');
			return [v.substring(0, index).trim(), v.substring(index + 1).trim()];
		})
		.forEach(([k, v]) => {
			k = convertToCamelCase(k);
			if (k.endsWith("Tools")) v = v.split(" ");
			metadata[k] = v;
	});

	return [metadata, body];
}

const NO_PARAMETERS = {
	"type": "object",
	"properties": {}
};

/**
 *
 * @param {string} text
 */
export function registerSkill(text) {
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
		script() {return content.trim();}
	};
}

/**
 * @param {AiChat.FunctionTool} tool
 * @return {OpenAI.Tool}
 */
function registerTool(tool) {
	const {name, description, parameters = NO_PARAMETERS, ...rest} = tool;
	if (!rest.script) throw new Error("Missing script for tool " + name);

	if (name in toolScriptRegistry) {
		if (toolScriptRegistry[name].script === rest.script) return;
		throw new Error("同名工具已存在？");
	}

	toolScriptRegistry[name] = rest;
	return {
		type: "function",
		function: {name, description, parameters}
	};
}

/**
 * 注册按需启用的工具
 * @param {string|undefined} name
 * @param {string} description
 * @param {Partial<AiChat.FunctionTool>[]} toolDefs
 * @param {Partial<{
 *     onActivated: function(): AiChat.FunctionTool[],
 *     hidden: boolean
 * }>} extra
 */
export function registerTools(name, description, toolDefs, {onActivated, hidden} = {}) {
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
		hidden
	};
}

/**
 * 注册默认启用的工具
 * @param {AiChat.FunctionTool[]} tools
 */
export function registerDefaultTools(tools) {
	for (const tool of tools) {
		defaultTools.push(registerTool(tool));
	}
}

const conversationChangedCallbacks = [];
export function onConversationChanged(callback) {
	conversationChangedCallbacks.push(callback);
}

let lastId;
$watch(selectedConversation, () => {
	const changed = selectedConversation.id !== lastId;
	if (changed) volatileEnvironment.value = {};
	if (selectedConversation.ready) {
		if (changed) {
			lastId = selectedConversation.id;
			runAllTools(selectedConversation.value, messages.value, false);
			for (const cb of conversationChangedCallbacks) {
				cb(selectedConversation.value, messages.value);
			}
		}
	} else {
		lastId = -1;
	}
});

/**
 *
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.AssistantMessage[]} messages
 * @param {boolean} isImporting
 */
export function runAllTools(conversation, messages, isImporting) {
	for (const {tool_calls, tool_responses} of messages) {
		if (tool_calls)
		for (let i = 0; i < tool_calls.length; i++) {
			const tc = tool_calls[i];

			const data = toolScriptRegistry[tc.function.name];
			const autorun = data?.autorun;
			if (isImporting ? autorun === "on_import" : autorun === true) {
				try {
					data.script(JSON.parse(tc.function.arguments || "null"), tool_responses[i], conversation);
				} catch (e) {
					console.error("Execute autorun tool", e);
				}
			}
		}
	}
}

/**
 *
 * @param {AiChat.AssistantMessage} response
 * @param {true|number=undefined} permitState
 * @return {Promise<boolean>}
 */
export async function runTools(response, permitState) {
	const tool_responses = response.tool_responses;
	let autoNext = true;
	const globalStorage = selectedConversation.value;

	for (let i = 0; i < response.tool_calls.length; i++) {
		let msg = tool_responses[i];
		const tc = response.tool_calls[i];

		if (msg?.success != null) {
			if (permitState !== i) continue;
			toolScriptRegistry[msg.tool_name].removed?.(msg, globalStorage);
		}
		msg = tool_responses[i] = {};

		if (tc.type === "function") {
			let {name} = tc.function;
			msg.tool_name = name;
			msg.time = Date.now();

			let isPromise;
			try {
				const parameters = JSON.parse(tc.function.arguments);

				const fn = toolScriptRegistry[name];
				let interactive = fn.interactive;
				if (interactive) {
					if (typeof interactive === "function") {
						interactive = interactive(parameters);
					}
					if (interactive === "secure") {
						if (!config.permitAllTools) {
							autoNext = false;
							if (permitState !== true && permitState !== i) continue;
						}
					} else {
						autoNext = false;
					}
				}

				let result = fn.script(parameters, msg, globalStorage);
				if (result instanceof Promise) {
					$update(updateMessageUI);
					isPromise = true;
					result = await result;
				}
				if (typeof result !== "string") result = result instanceof ContentPart ? result.content : JSON.stringify(result);
				msg.success = true;
				msg.content = result || "";
			} catch (e) {
				console.error(e);
				msg.success = false;
				msg.content = prettyError(e);
				autoNext = false;
			}
			msg.time = Date.now();
			if (isPromise) $update(updateMessageUI);
		}
	}

	return autoNext;
}

export function setSystemPrompt(system_prompt) {
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
}