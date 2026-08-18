import {
	messages,
	onConversationBeforeunload,
	onConversationLoaded,
	selectedConversation,
	updateMessageUI
} from "./states.js";
import {$state, $update, $watch, debugSymbol, unconscious} from "unconscious";
import {loadingBlock, prettyError} from "./utils/utils.js";

import "./toolset.css";
import {compileSchema, validateAndShowError} from "unconscious/common/json-schema-utils.js";
import {showToast} from "./components/Toast.js";
import {MCPClient} from "/common/MCPClient.js";
import {parseJson5} from "unconscious/common/Json.js";
import {highlightJsonLike} from "./markdown/highlight.js";
import {getCombinedPreset, markMessageDirty} from "./database.js";

export const TOOL_NAME = debugSymbol("TOOL_NAME");
export const TOOL_IS_RUNNING = debugSymbol("TOOL_IS_RUNNING");
const TOOL_PARAM = debugSymbol("TOOL_PARAM");

/**
 * @type {Record<string, string | function(): string>}
 */
export const PLACEHOLDERS = {};

/**
 * 常开模块
 * @type {Set<string>}
 */
export const defaultGroups = new Set(["Use"]);
/**
 * 工具集摘要，在调用后激活工具
 * @type {Record<string, {description: string, tools: string[], skill?: string, hidden: boolean | 'manual', systemPrompt: string}>}
 */
export const toolset = {};
/**
 * 根据工具摘要按需激活的工具元数据
 * @type {Record<string, OpenAI.Tool>}
 */
export const tools = {};
/**
 * 工具脚本，调用后执行的代码都在这里
 * @type {Record<string, AiChat.FunctionToolImpl & { parameters?: OpenAI.ObjectSchema, default?: boolean }>}
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

const listUsableToolset = activatedModules => Object.keys(toolset).filter(name => !toolset[name].hidden && !activatedModules.has(name));

const NSLOOKUP = debugSymbol("Namespace-less Lookup");

toolset["Use"] = {
	description: "允许模型激活工具",
	hidden: "manual"
};
toolScriptRegistry["Use"] = {
	reentrant: true,
	async script({modules}, response, conv) {
		let {allowedTools, activatedModules} = conv;

		this.undo(response, conv);

		const newToolNames = [];

		response.modules = modules;
		// UIOnly
		response.newTools = newToolNames;

		try {
			for (const moduleName of modules) {
				if (!toolset[moduleName] || activatedModules.has(moduleName))
					throw "Tool schema validation error:\n$.modules: value("+JSON.stringify(moduleName)+") must in "+JSON.stringify(listUsableToolset(activatedModules));

				let {tools: toolArr, onActivated, depend} = toolset[moduleName];

				if (depend) depend.forEach(mod => {
					if (!activatedModules.has(mod)) modules.push(mod);
				})

				activatedModules.add(moduleName);
				if (onActivated) {
					toolArr = await onActivated(conv);
					toolArr = toolArr?.map(t => t.name || t) || [];
				}

				toolArr?.forEach(name => {
					if (!allowedTools.has(name)) {
						allowedTools.add(name);
						newToolNames.push(name);
					}
				});
			}
		} catch (e) {
			this.undo(response, conv);
			for (const moduleName of modules) activatedModules.delete(moduleName);
			throw e;
		}

		return "You can use these tools now: "+newToolNames.map(s => s.slice(s.lastIndexOf(":")+1)).join(", ");
	},

	renderer(context) {
		if (context.success === false) return;
		if (!context.newTools) return loadingBlock("等待调用结果……");

		const isRevoked = $state(!context.content.startsWith("You"));

		return (
			<div className={`skills`} class:revoked={isRevoked}>
				<div className="tool-label-group">
					<span>⚡ 获得新能力:</span>
					{context.newTools.map(t => (
						<span className="tool-tag">{t}</span>
					))}
				</div>

				<span style={{flex: 1}}></span>

				{() => unconscious(isRevoked) ? (
					<div className="revoked-status tool-label-group">
						<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
						已撤销
					</div>
				) : (
					<button className="revoke-btn" onClick={() => {
						isRevoked.value = true;
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
	undo({modules}, conv) {
		delete conv[NSLOOKUP];

		const {allowedTools, activatedModules} = conv;
		if (!allowedTools || !modules) return;

		allowedTools.clear();
		for (const moduleName of modules) {
			activatedModules.delete(moduleName);
			toolset[moduleName]?.onDeactivated?.(conv);
		}
		activatedModules.forEach(name => toolset[name]?.tools?.forEach(name => allowedTools.add(name)));
	}
};

/**
 *
 * @param {{allowedTools: Set<string>, activatedModules: Set<string>}} conversation
 * @return {Promise<[OpenAI.Tool[], string]>}
 */
export const getAvailableTools = async (conversation) => {
	let {allowedTools, activatedModules} = conversation;

	let outputTools = [];
	let systemPrompt = [];
	for (const name of activatedModules) {
		let prompt = toolset[name]?.systemPrompt;
		if (prompt) {
			if (typeof prompt === "function") prompt = prompt(conversation, outputTools);
			systemPrompt.push(prompt);
		}
	}
	systemPrompt = await Promise.all(systemPrompt);

	let tmpArr;
	if (activatedModules.has("Use") && (tmpArr = listUsableToolset(activatedModules)).length) {
		outputTools.push({
			type: "function",
			function: {
				name: "Use",
				description: "Activate extra toolset needed in current session. Do not call this if request can be answered directly or just topic related to it.\n\n" + (
					tmpArr.map(name => name+": "+toolset[name].description).join("\n")
				),
				parameters: {
					type: "object",
					properties: {
						modules: {
							type: "array",
							minItems: 1,
							items: { type: "string", enum: tmpArr },
						}
					},
					required: ["modules"]
				},
			}
		});
	}

	if (allowedTools) {
		for (const name of allowedTools) {
			const tool = tools[name];
			if (!tool) throw '工具 '+name+' 不存在';
			outputTools.push(tool);
		}
	}
	return [outputTools.sort((a, b) => {
		return a.function.name.localeCompare(b.function.name);
	}), systemPrompt.join("\n\n")];
};

const convertToCamelCase = str => str.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());

const YAML_BLOCK = /^[>|][+-]?$/;

/**
 * 解析 YAML Frontmatter.
 *
 * YAML？我不知道什么是 112KB 的 js-yaml，这个函数只有几百字节，也只应该几百字节。
 * 它不支持类型转换锚点引用嵌套列表JSON文档分隔符……但够用
 * @param {string} content
 * @return {[{}, string, number]}
 */
export const parseFrontmatter = content => {
	const metadata = {};
	let end;

	if (!content.startsWith("---\n") || (end = content.indexOf("\n---", 3)) < 0)
		return [metadata, content, 0];

	const body = content.slice(end + 4).trim();
	const stack = [
		[-1, metadata]
	];

	let ctx, prevIndent, container, prevKey, state;
	const handleIndent = (indent) => {
		while(1) {
			[prevIndent, container, prevKey, state] = ctx = stack.at(-1);
			if (indent >= prevIndent) break;
			stack.pop();

			if (state) {
				const [a, b] = state[0];
				if (b !== '+') {
					const char = a === '|' ? '\n' : ' ';
					const flag = container.endsWith(char);
					container = container.trim();
					if (b !== '-' && flag) container += char;
				}
			}

			const [_, newContainer] = stack.at(-1);
			if (prevKey == null) newContainer.push(container);
			else newContainer[prevKey] = container;
		}
	}

	const MARK = -1/0;
	const lines = content.slice(4, end).trim().split("\n");
	for (let line1 of lines) {
		let line = line1.trim();
		const indent = line1.length - line.length;

		[prevIndent] = ctx = stack.at(-1);
		if (prevIndent === MARK) {
			if (!line) continue;
			ctx[0] = prevIndent = indent;
		}

		handleIndent(indent);

		if (state) {
			ctx[1] += line1.slice(state[1] || (state[1] = indent))+(state[0] === '|' ? '\n' : ' ');
			continue;
		}

		// 注释应该占何种地位？
		if (line.startsWith("#")) continue;

		let key, value;

		if (line.startsWith('- ')) {
			if (null == container) {
				ctx[1] = container = [];
			} else if (!Array.isArray(container)) {
				throw new Error("Cannot mix list and object");
			}

			line = value = line.slice(2).trim();
		}
		block: {
			const index = line.indexOf(':');
			if (index < 0) {
				if (value) break block;
				continue;
			}

			const isArray = value;
			if (isArray) stack.push([ indent, container = {}, null ]);

			key = convertToCamelCase(line.slice(0, index));
			value = line.slice(index+1).trim();
			if (!value) {
				// 同级 a:\nb:
				if (!isArray && prevIndent === indent) handleIndent(indent-1);
				stack.push([ indent, null, key ]);
				continue;
			}
		}

		const ch = value[0];
		if (ch === "'") value = value.slice(1, -1).replaceAll("''", "'");
		else if (ch === '"') value = parseJson5(value);
		else if (YAML_BLOCK.test(value)) {
			stack.push([ MARK, '', key, [value, 0] ]);
			continue;
		} else if (value === '[' || value === '{') {
			try {
				value = parseJson5(value);
			} catch {
				// literal string
			}
		}

		if (container == null) ctx[1] = container = {};

		if (key == null) container.push(value);
		else container[key] = value;
	}

	handleIndent(-1);

	return [metadata, body, lines.length+4];
};

const NO_PARAMETERS = {
	type: "object",
	properties: {}
};

/**
 * 注册按需启用的工具
 * @param {string|undefined} name
 * @param {string} description
 * @param {AiChat.FunctionTool[]} toolDefs
 * @param {{
 *     namespace?: string,
 *     onActivated?: function(AiChat.Conversation): AiChat.FunctionTool[],
 *     onDeactivated?: function(AiChat.Conversation),
 *     hidden?: boolean | 'manual',
 *     systemPrompt: string | function(AiChat.Conversation): string | Promise<string>,
 *     default?: boolean,
 *     data?: any
 * }} extra
 */
export const registerToolset = (name, description, toolDefs, {
	namespace,
	default: defaultEnabled,
	...rest
} = {}) => {
	const toolArr = [];
	for (const tool of toolDefs) {
		const {name, description, parameters = NO_PARAMETERS, ...rest} = tool;

		if (name.includes(":")) throw new Error("Invalid character ':' in tool "+name);

		const nsName = (namespace ? namespace+":":"") + name;
		if (!rest.script) throw new Error("Missing tool script "+name);

		toolArr.push(nsName);

		const script = toolScriptRegistry[nsName]?.script;
		if (script === rest.script) continue;
		if (script) throw new Error("Duplicate tool "+nsName);

		parameters.additionalProperties = false;
		compileSchema(parameters, true);
		rest.parameters = parameters;
		toolScriptRegistry[nsName] = rest;

		tools[nsName] = {
			type: "function",
			function: {name, description, parameters}
		};
	}

	if (defaultEnabled) defaultGroups.add(name);

	toolset[name] = {
		description,
		tools: toolArr,
		...rest
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
	const mcpToolGroup = /*"MCP_"+*/mcpName;
	const registryPrefix = 'MCP:'+mcpToolGroup+":";

	let toolArrayPromise;

	client.statusListener = (open) => {
		if (!open) {
			if (toolArrayPromise) toolArrayPromise.then(toolNames => {
				for (const name of toolNames) {
					delete tools[name];
					delete toolScriptRegistry[name];
				}
			});
		} else {
			toolArrayPromise = client.listTools().then(({tools: toolArray}) => toolArray.map(({
				name, description, inputSchema,
				title, annotations, execution
			}) => {
				// title: string
				// annotations: {readOnlyHint: boolean, destructiveHint: boolean, openWorldHint: boolean, idempotentHint: boolean}
				// execution: {taskSupport: 'forbidden'}

				const displayName = (options.prefix?mcpToolGroup+"_":"")+name;
				const registryName = registryPrefix+name;

				tools[registryName] = {
					type: "function", function: {
						name: displayName, description,
						parameters: inputSchema
					}
				};
				toolScriptRegistry[registryName] = {
					parameters: inputSchema,
					interactive: annotations?.destructiveHint && 'secure',
					title: title && (() => title),
					async script(parameters, response) {
						const result = await client.callTool(name, parameters);
						response.success = !result.isError;

						const content = result.content;
						response.content = content.length === 1 && content[0].type === 'text' ? content[0].text : content;
					}
				};
				return registryName;
			}));
		}
	};

	const connectServer = async () => {
		if (!client.isOpen) {
			const closeToast = showToast("正在连接MCP服务器 ["+mcpToolGroup+"]", "ok", 0);
			try {
				await client.connect();
			} catch (e) {
				throw "无法连接到MCP服务器 ["+mcpToolGroup+"]\n"+e.message;
			} finally {
				closeToast();
			}
		}
		return toolArrayPromise;
	}

	registerToolset(mcpToolGroup, mcpDescription, [], {
		async systemPrompt(conv) {
			if (!client.isOpen) {
				const tools = await connectServer();
				toolset[mcpToolGroup].tools = tools;
				delete conv[NSLOOKUP];

				const allowedTools = conv.allowedTools;
				for (const name of allowedTools) {
					if (name.startsWith(registryPrefix)) {
						allowedTools.delete(name)
					}
				}
				tools.forEach(name => allowedTools.add(name));
			}
			return ''
		},
		onActivated: connectServer,
		data: "MCP",
		hidden: options.hidden
	});

	return () => {
		client.disconnect("unregistered");
		delete toolset[mcpToolGroup];
	}
};

const CONV_REACTIVE_MAP = debugSymbol("CONV_REACTIVE_MAP");

onConversationLoaded((conv, msg) => redoToolCalls(conv, msg, 0));
onConversationBeforeunload((conv) => delete conv[CONV_REACTIVE_MAP]);

/**
 * @param {AiChat.Conversation} conv
 * @param {string} name
 * @param {Record<string, any>} parameters
 * @returns {Promise<number>}
 */
const getToolUserInteractionLevel = async (conv, name, parameters) => {
	let fn = toolScriptRegistry[name];
	const allowed = (await getCombinedPreset(conv)).permittedTools;
	let interactive = allowed?.includes("!"+name) ? 'secure' : fn?.interactive;
	if (interactive) {
		if (typeof interactive === "function") {
			interactive = await interactive(parameters, conv);
		}
		if (interactive === "secure") {
			return !allowed?.includes(name) && !allowed?.includes('*') && !conv.grantedTools?.has(name) ? 2 : 0;
		}

		return 1;
	}

	return 0;
}

const UNSAFE_TOOL_DENY_MESSAGE = "User doesn't permit this tool use. Nothing changed. STOP and wait for user.";

/**
 *
 * @param {AiChat.AssistantMessage} response
 * @param {AiChat.Conversation} conv
 * @param {true|number|null=null} forceRerun
 * @param {boolean=} allowUnsafe
 * @return {Promise<boolean>}
 */
export const runTools = async (response,  conv, forceRerun, allowUnsafe) => {
	markMessageDirty(response);
	const {tool_calls, tool_responses} = response;

	let autoCommit = true;

	const callTool = async i => {
		const tc = tool_calls[i];
		let msg = tool_responses[i];
		let {name} = tc.function;

		try {
			let fn = toolScriptRegistry[name];
			if (!fn) {
				// 先连接MCP服务器确保工具注册了
				await getAvailableTools(conv);

				// 命名空间速查
				let nsLookup = conv[NSLOOKUP];
				if (!nsLookup) {
					conv[NSLOOKUP] = nsLookup = new Map;
					for (let toolName of conv.allowedTools) {
						nsLookup.set(tools[toolName].function.name, toolName);
					}
				}

				name = nsLookup.get(name);
				if (null == name) throw 'The tool name is invalid';

				fn = toolScriptRegistry[name];
			}

			if (msg?.success != null) {
				if (forceRerun !== i) return;
				if (msg.success) fn?.undo?.(msg, conv, tc);
			}

			msg = tool_responses[i] = { [TOOL_NAME]: name };

			const parameters = getToolParameters(msg, tc);
			const allowRun = name === 'Use' || conv.allowedTools.has(name);

			if (!(fn && allowRun)) {
				// 帮模型擦屁股
				if (toolset[name]) {
					tc.function = {
						arguments: JSON.stringify({ modules: [name] }),
						name: name = msg[TOOL_NAME] = 'Use',
					}
				} else {
					throw 'The tool exists, but is not allowed.';
				}
			}

			const schema = fn.parameters;
			if (schema) {
				let error = validateAndShowError(parameters, schema);
				if (error) {
					const fix = fn.fix;
					if (fix) {
						fix(parameters, error);
						error = validateAndShowError(parameters, schema);
					}
					if (error) throw "Schema validation error:\n"+error;
					// 改变历史
					tc.function.arguments = JSON.stringify(parameters);
				}
			}

			msg.time = Date.now();
			const uiLevel = await getToolUserInteractionLevel(conv, name, parameters);
			if (uiLevel) {
				autoCommit = false;
				if (uiLevel === 2) {
					if (null == forceRerun) {
						delete msg.time;
						return;
					}

					if (!allowUnsafe) {
						throw UNSAFE_TOOL_DENY_MESSAGE;
					}
				}
			} else if (false === allowUnsafe) {
				throw UNSAFE_TOOL_DENY_MESSAGE;
			}

			msg[TOOL_IS_RUNNING] = true;
			let result = fn.script(parameters, msg, conv);
			if (result instanceof Promise) {
				$update(updateMessageUI);
				result = await result;
			}
			if (result !== undefined) {
				if (typeof result !== "string")
					result = result instanceof ContentPart ? result.content : JSON.stringify(result);
				msg.success = true;
				msg.content = result;
			}
		} catch (e) {
			if (typeof e === 'string' && !e.startsWith('Error: '))
				e = 'Error: '+e;
			console.error(e);
			/*msg = tool_responses[i] = {
				[TOOL_NAME]: name,
				success: false,
				content: prettyError(e)
			};*/
			if (!msg) msg = tool_responses[i] = { [TOOL_NAME]: name };
			msg.success = false;
			msg.content = prettyError(e);
			if (!(await getCombinedPreset(conv)).afkState)
				autoCommit = false;
		}
		delete msg[TOOL_IS_RUNNING];
		if (forceRerun === true && null == msg.content) throw 'some interactive tool need user input';
		if (msg.time) msg.duration = Date.now() - msg.time;
	};

	if (typeof forceRerun === "number") await callTool(forceRerun);
	else for (let i = 0; i < tool_calls.length; i++) await callTool(i);

	return autoCommit;
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
					if (tr.time == null || (reentrantOnly && !impl?.reentrant)) continue;

					impl?.undo?.(tr, global, tc);
				} catch (e) {
					console.error(e);
					showToast(<div>无法撤销工具调用【{tc.function.name}】<br/>
						详情: {prettyError(e)}<br/>
						参数: <div dangerouslySetInnerHTML={highlightJsonLike(tc.function.arguments)}></div><br/>
						响应: <div dangerouslySetInnerHTML={highlightJsonLike(tr)}></div>
					</div>, 'error', 60000);
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
 * @param {boolean} [silentFail]
 * @return {Record<string, any>}
 */
export const getToolParameters = (response, toolcall, silentFail) => {
	let parsed = response[TOOL_PARAM];
	if (!parsed) {
		const text = toolcall.function.arguments;
		if (silentFail && !text?.endsWith("}")) return;
		try {
			parsed = response[TOOL_PARAM] = JSON.parse(text);
		} catch (e) {
			if (silentFail) return;
		}
	}
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