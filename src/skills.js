import {config, messages, onConversationBeforeunload, onConversationLoaded, selectedConversation} from "./states.js";
import {$state, $update, $watch, debugSymbol, unconscious} from "unconscious";
import {loadingBlock, prettyError} from "./utils/utils.js";

import "./skills.css";
import {updateMessageUI} from "./components/MessageList.jsx";
import {compileSchema, jsonEval, validateAndShowError} from "unconscious/common/json-schema-utils.js";
import {showToast} from "./components/Toast.js";
import {MCPClient} from "/common/MCPClient.js";
import {setConversationTitle} from "./components/ConversationList.jsx";

export const TOOL_NAME = debugSymbol("TOOL_NAME");
const TOOL_PARAM = debugSymbol("TOOL_PARAM");

/**
 * @type {Record<string, string | function(): string>}
 */
export const PLACEHOLDERS = {};

/**
 * 常开模块
 * @type {Set<string>}
 */
export const defaultGroups = new Set(["Use", "Skill"]);
/**
 * 工具组摘要，在调用后激活工具
 * @type {Record<string, {description: string, allowedTools: string[], skill?: string, hidden: boolean | 'manual', systemPrompt: string}>}
 */
export const toolGroups = {};
/**
 * 技能摘要
 * @type {Record<string, {description: string, content: string}>}
 */
const skills = {};
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
	constructor(content = []) {
		this.content = content;
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

export {jsonEval} from "unconscious/common/json-schema-utils.js";


export const SetTitle = {
	type: "function",
	function: {
		name: "SetTitle",
		description: "设置对话标题",
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

toolScriptRegistry["SetTitle"] = {
	default: true,
	interactive: true,
	script({title}, response, conv) {
		const last = messages.at(-1);
		if (!last.content) messages.pop();
		else {
			delete last.tool_calls;
			delete last.tool_responses;
			last.finish_reason = 'stop';
		}

		setConversationTitle(conv, title, true);
	},
	title(tc, ctx = {}) {
		return "设置标题 "+getToolParameters(ctx, tc).title;
	}
};

const use_isRevoked = debugSymbol("use_isRevoked");
const listUsableToolGroups = activatedModules => Object.keys(toolGroups).filter(name => !toolGroups[name].hidden && !activatedModules.has(name));

toolGroups["Use"] = {
	description: "允许模型激活工具",
	hidden: "manual"
};
toolScriptRegistry["Use"] = {
	reentrant: true,
	default: true,
	async script({modules}, response, globalStorage) {
		let {allowedTools, activatedModules} = globalStorage;
		if (!allowedTools) {
			allowedTools = new Set;
			activatedModules = new Set(defaultGroups);
			globalStorage.allowedTools = allowedTools;
			globalStorage.activatedModules = activatedModules;
		}

		this.undo(response, globalStorage);

		const newToolNames = [];

		for (const moduleName of modules) {
			if (!toolGroups[moduleName] || activatedModules.has(moduleName))
				throw "Tool schema validation error:\n$.modules: value("+JSON.stringify(moduleName)+") must in "+JSON.stringify(listUsableToolGroups(activatedModules));

			let {allowedTools: allowedToolsArr, onActivated: dynamicCallback} = toolGroups[moduleName];

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

		response.newModules = modules;
		// UIOnly
		response.newTools = newToolNames;

		if (response[use_isRevoked]) response[use_isRevoked].value = false;
		return "You can use these tools now: "+newToolNames.join(", ");
	},

	renderer(context) {
		if (context.success === false) return;
		if (!context.newTools) return loadingBlock("等待调用结果……");

		const isRevoked = !context.content.startsWith("You");
		if (!context[use_isRevoked]) context[use_isRevoked] = $state(isRevoked);

		return (
			<div className={`skills`} class:revoked={context[use_isRevoked]}>
				<div className="tool-label-group">
					<span>⚡ 获得新能力:</span>
					{context.newTools.map(t => (
						<span key={t} className="tool-tag">{t}</span>
					))}
				</div>

				<span style={{flex: 1}}></span>

				{() => unconscious(context[use_isRevoked]) ? (
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
		activatedModules.forEach(name => toolGroups[name]?.allowedTools?.forEach(name => allowedTools.add(name)));
	}
};

toolGroups["Skill"] = {
	description: "允许模型激活技能",
	hidden: "manual"
};
toolScriptRegistry["Skill"] = {
	default: true,
	script({skill}) {
		return skills[skill].content;
	},
	title(req, ctx = {}) {
		const skill = getToolParameters(ctx, req).skill;
		return "激活技能 "+skill;
	}
};

/**
 *
 * @param {{allowedTools: Set<string>, activatedModules: Set<string>}} conversation
 * @return {Promise<[OpenAI.Tool[], string]>}
 */
export const getAvailableTools = async (conversation) => {
	let {allowedTools, activatedModules = defaultGroups} = conversation;

	const systemPrompt = [];

	for (const name of activatedModules) {
		let prompt = toolGroups[name]?.systemPrompt;
		if (prompt) {
			if (typeof prompt === "function") prompt = await prompt();
			systemPrompt.push(prompt);
		}
	}

	let result = [];

	let tmpArr;
	if (activatedModules.has("Use") && (tmpArr = listUsableToolGroups(activatedModules)).length) {
		result.push({
			type: "function",
			function: {
				name: "Use",
				description: "Activate capability modules (tools) needed in current session. Do not call this if request can be answered directly or just topic related to it.\n\n" + (
					tmpArr.map(name => name+": "+toolGroups[name].description).join("\n")
				),
				parameters: {
					type: "object",
					properties: {
						modules: {
							type: "array",
							minItems: 1,
							items: { enum: tmpArr },
						}
					},
					required: ["modules"]
				},
			}
		});
	}

	if (activatedModules.has("Skill") && (tmpArr = Object.keys(skills)).length) {
		result.push({
			type: "function",
			function: {
				name: "Skill",
				description: `Read one skill's content.
When users ask you to perform tasks, check if any of the available skills match and invoke Skill tool.
Skills provide specialized capabilities and domain knowledge.

${tmpArr.map(name => name + ": " + skills[name].description).join("\n")}`,
				parameters: {
					type: "object",
					properties: {
						skill: {
							type: "string",
							enum: tmpArr,
						}
					},
					required: ["skill"]
				},
			}
		});
	}

	if (allowedTools) {
		for (const name of allowedTools) {
			const tool = tools[name];
			if (!tool) throw '工具 '+name+' 不存在';
			result.push(tool);
		}
	}
	return [result, systemPrompt.join("\n\n")];
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
	const [meta, content] = parseSkillMetadata(text);
	if (!meta) throw new Error("SKILL.md format error");

	const name = meta.name;
	if (name in skills) throw new Error("同名技能已存在？");

	skills[name] = {
		description: meta.description,
		content: content.trim(),
	}
};

/**
 * @param {AiChat.FunctionTool} tool
 * @return {OpenAI.Tool}
 */
const registerTool = tool => {
	const {name, description, parameters = NO_PARAMETERS, ...rest} = tool;
	if (!rest.script) throw new Error("Missing script for tool " + name);

	const script = toolScriptRegistry[name]?.script;
	if (script === rest.script) return;
	if (script) throw new Error("同名工具已存在？");

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
 *     systemPrompt: string,
 *     default?: boolean
 * }>} extra
 */
export const registerTools = (name, description, toolDefs, {onActivated, hidden, systemPrompt, default: defaultEnabled} = {}) => {
	const toolNames = [];
	for (const toolDef of toolDefs) {
		const tool = registerTool(toolDef);
		if (tool) tools[toolDef.name] = tool;
		toolNames.push(toolDef.name);
	}

	if (defaultEnabled) defaultGroups.add(name);

	toolGroups[name] = {
		description,
		allowedTools: toolNames,
		onActivated,
		hidden,
		systemPrompt
	};
};

/**
 *
 * @param {string} mcpBaseUrl
 * @param {string} mcpName
 * @param {string} mcpDescription
 * @param {Object} options
 */
export const addMCPServer = (mcpBaseUrl, mcpName, mcpDescription = "External tools (MCP Server).", options) => {
	const client = new MCPClient(mcpBaseUrl, options);
	let toolArrayPromise;

	const mcpToolGroup = /*"MCP_"+*/mcpName;
	client.statusListener = (open) => {
		if (!open) for (const key in tools) {
			if (key.startsWith(mcpToolGroup)) {
				delete tools[key];
				delete toolScriptRegistry[key];
			}
		}
		else {
			toolArrayPromise = client.listTools().then(({tools}) => tools.map(({name, description, inputSchema}) => {
				const displayName = mcpToolGroup+"_"+name;
				tools[displayName] = {
					type: "function", function: {
						name: displayName, description,
						parameters: inputSchema
					}
				};
				toolScriptRegistry[displayName] = {
					async script(parameters, response) {
						const result = await client.callTool(name, parameters);
						response.success = !result.isError;
						response.content = result.content;
					}
				};
				return displayName;
			}));
		}
	};

	const connectServer = async () => {
		if (!client.isOpen) {
			const closeToast = showToast("正在连接MCP服务器，请稍候", "ok", 0);
			try {
				await client.connect();
			} catch (e) {
				showToast("无法连接到MCP服务器\n"+prettyError(e), "error", 0);
			} finally {
				closeToast();
			}
		}
		return toolArrayPromise;
	}

	registerTools(mcpToolGroup, mcpDescription, [], {
		onActivated: connectServer
	});

	onConversationLoaded(() => {
		if (selectedConversation.activatedModules?.has(mcpToolGroup)) {
			if (client.readyState === EventSource.CLOSED) connectServer();
		}
	});

	return () => {
		client.disconnect("unregistered");
		delete toolGroups[mcpToolGroup];
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
					? 'Call \'Use\' to activate this tool.'
					: toolGroups[name]
						? 'This is a tool group, not real tool, call Use(['+JSON.stringify(name)+']) to activate'
						: 'Tool not exist';
			}

			const strings = config.permittedTools;
			let interactive = strings.includes("!"+name) ? 'secure' : fn.interactive;
			if (interactive) {
				/*if (typeof interactive === "function") {
					interactive = interactive(parameters);
				}*/
				if (interactive === "secure") {
					if (!strings?.includes(name) && !strings?.includes('*') && !selectedConversation.grantedTools?.has(name)) {
						autoNext = false;
						if (forceRerun === true || (forceRerun === i && !allowUnsafe)) {
							throw "User doesn't permit this tool use. Nothing changed. STOP and wait for user.";
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

			const schema = fn.parameters;
			if (schema) {
				const error = validateAndShowError(parameters, schema);
				if (error) throw "Tool schema validation error:\n"+error;
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
			if (!config.ignoreToolError)
				autoNext = false;
		}
		if (forceRerun === true && null == msg.content)
			throw 'some interactive tool need user input';
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
 * @param {boolean} reentrantOnly
 */
export const undoToolCalls = (global, messages, first, reentrantOnly) => {
	for (let i = messages.length - 1; i >= first; i--) {
		const {tool_calls, tool_responses} = messages[i];
		if (tool_responses) {
			for (let j = tool_responses.length - 1; j >= 0; j--) {
				const tc = tool_calls[j], tr = tool_responses[j];
				try {
					const impl = toolScriptRegistry[tc.function.name];
					const reentrant = impl.reentrant;
					if (reentrantOnly && !reentrant) continue;

					impl.undo?.(tr, global, tc);
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
 * @return {import("unconscious").Reactive<?>}
 */
const createStateListener = (conv, name) => {
	let map = conv[CONV_REACTIVE_MAP];
	if (!map) map = conv[CONV_REACTIVE_MAP] = new Map;

	let result = map.get(name);
	if (!result) map.set(name, result = $state());
	return result;
}

/**
 * 监听对话上的响应式变量更新
 * @param {AiChat.Conversation} conv
 * @param {string} name
 * @param {function(?): void} callback
 * @param {boolean=true} triggerNow
 */
export const watchConversationState = (conv, name, callback, triggerNow) => {
	const state = createStateListener(conv, name);
	$watch(state, () => callback(unconscious(state)), triggerNow);
}

/**
 * 触发对话上的响应式变量更新
 * @param {AiChat.Conversation} conv
 * @param {string} name
 * @param {any=} value
 */
export const updateConversationState = (conv, name, value) => {
	const state = createStateListener(conv, name);
	state.value = value;
	$update(state);
}