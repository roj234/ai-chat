import {getAvailableTools, getToolParameters, registerToolset, toolScriptRegistry, toolset} from "/src/toolset.js";
import {getMessagesCacheFirst, kvListGet, markMessageDirty, updateConversation} from "/src/database.js";
import {agentLoop} from "/src/api-request.js";
import {$asyncState, $cleanup, $state, $update, $watch, debugSymbol, unconscious} from "unconscious";
import {
	config,
	conversations,
	messages,
	runningConversations,
	selectedConversation,
	switchToConversation,
	updateMessageUI
} from "/src/states.js";
import {fileAccess} from "./fileAccess.js";
import {compileSchema} from "unconscious/common/json-schema-utils.js";
import "./subagent.css";
import {showToast} from "/src/components/Toast.js";
import {prettyError} from "/src/utils/utils.js";
import {DI} from "/src/hooks.js";

const readFile = fileAccess("read");

const INIT_AGENT_SYM = debugSymbol("InitAgent");
const EVAL_AGENT_SYM = debugSymbol("EvaluateAgent");
const CONVERSATION_CACHE = debugSymbol("CONVERSATION_CACHE");

const findConversation = response => response[CONVERSATION_CACHE] || (response[CONVERSATION_CACHE] = conversations.find(item => item.id === response.agentId));

/**
 *
 * @param par
 * @param response
 * @param conv
 * @returns {Promise<void>}
 */
async function createSubagent(par, response, conv, tools, modules) {
	/**
	 * @type {AiChat.Conversation}
	 */
	const conversation = {
		title: "子代理 " + par.name + " for #" + conv.id,
		time: Date.now(),
		// 继承文件系统
		fs_type: conv.fs_type,
		fs_base: conv.fs_base,
		mnt: structuredClone(conv.mnt),
		// 有些工具比如SetTimeout判断它是否存在从而进入假设无UI的无头模式
		owner: conv.id,
		// 覆盖系统配置
		overrides: {
			tools: true,
			maxToolTurns: 150, // a sanity value
			permittedTools: ['*'],
			afkState: 1,
			sound: false,
			disableFinishToast: true
		},
		allowedTools: new Set(),
		activatedModules: new Set(modules)
	};

	const modelType = par.model || 'inherit';
	if (modelType !== 'inherit') {
		const presetName = "_subagent_"+modelType;
		try {
			const preset = await kvListGet("preset", presetName);
			Object.assign(conversation.overrides, preset);
		} catch (e) {
			showToast("你未配置子代理模型定义【"+presetName+"】，回落到 inherit", "", 30000);
		}
	}

	let schema;
	const responseSchemaPath = par.responseSchemaPath;
	if (responseSchemaPath) {
		const text = await readFile({
			path: responseSchemaPath,
			noTruncate: true
		}, response, conv);
		schema = JSON.parse(text);
		compileSchema(schema, true);
		conversation.sa_schema = schema;
	}

	const systemPromptArr = par.systemPrompt;
	let systemPrompt = '';
	if (systemPromptArr?.length) {
		for (const item of systemPromptArr) {
			if (item.type === 'file') {
				systemPrompt += await readFile({
					path: item.path,
					noTruncate: true
				}, response, conv)
			} else {
				systemPrompt += item.text;
			}
		}
	}

	if (responseSchemaPath) systemPrompt += `<structured-output>
You MUST call the \`AgentFinish\` tool to complete your task, providing your final result conforming to the specified JSON Schema.
Do NOT stop or return results in any other way — only \`AgentFinish\` signals task completion.
</structured-output>`;

	let preset = config;
	try {
		preset = await kvListGet("preset", "_subagent_prompt");
	} catch {}

	await toolScriptRegistry['Use'].script({ modules: responseSchemaPath ? ['Subagent/Child'] : [] }, {}, conversation);
	tools.forEach(t => conversation.allowedTools.add(t));
	const [tools_, toolPrompt] = await getAvailableTools(conv);

	conversation.overrides.systemPrompt = (preset.systemPrompt + systemPrompt + toolPrompt) || '---\n---';

	/**
	 * @type {OpenAI.Message[]}
	 */
	const initMessages = [{
		role: 'user',
		content: par.userMessage
	}];

	await updateConversation(conversation, initMessages);
	conversations.unshift(conversation);
	response.agentId = conversation.id;
	response.time = Date.now();
	response[CONVERSATION_CACHE] = conversation;
}
const createSubagentWrapper = async (ctx, par, conv) => {
	let promise = ctx[INIT_AGENT_SYM];
	if (promise) return promise;

	if (!ctx.agentId) {
		const modules = par.tools.filter(tool => tool.startsWith("MODULE:")).map(t => t.slice(7));
		const tools = par.tools.filter(tool => !tool.startsWith("MODULE:"));

		const missing = tools.filter(name => !toolScriptRegistry[name]);
		if (missing.length) throw 'Invalid tool name: '+missing+" (notice that external tools have namespace and must be called by MODULE:moduleName)";

		const missing2 = modules.filter(name => !toolset[name]);
		if (missing2.length) throw 'Invalid module name: '+missing2;

		return (ctx[INIT_AGENT_SYM] = createSubagent(par, ctx, conv, tools, modules)).finally(() => delete ctx[INIT_AGENT_SYM]);
	}
};

const subagentLoop = async conversation => {
	const messages = await getMessagesCacheFirst(conversation);

	let stop = messages.at(-1).finish_reason;
	let locked;
	try {
		while (stop === 'tool_calls' || stop === undefined || stop === 'interrupt') {
			if (!locked) {
				locked = true;
				DI.lock?.(conversation.id);
				$update(updateMessageUI);
			}
			stop = await agentLoop(conversation, messages);
		}
	} finally {
		if (locked) DI.unlock?.(conversation.id);
	}

	let content;
	if (stop === false) {
		const tool = messages.at(-2).tool_calls?.find(item => item.function.name === 'AgentFinish');
		if (tool) {
			content = tool.function.arguments;
			messages.pop();
			return content;
		}
	} else {
		return messages.at(-1).content;
	}
};
const subagentLoopWrapper = ctx => {
	const conv = findConversation(ctx);
	let promise = conv[EVAL_AGENT_SYM];
	if (promise) return promise;
	promise = conv[EVAL_AGENT_SYM] = subagentLoop(conv);
	promise.finally(() => {
		delete conv[EVAL_AGENT_SYM];
	});
	return promise;
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const CreateSubagent = {
	name: 'CreateAgent',
	description:
		"Creates a agent to autonomously execute a task and return the result. " +
		"Equip it with all tools needed to complete the task. " +
		"Prompts in 'systemPrompt' array are concatenated. " +
		"If 'responseSchemaPath' (JSON Schema file) is provided, the agent's result will conform to that schema." +
		"\nThe agent MAY operate in async mode, the call returns immediately with an agentId; use QueryAgentStatus to poll and retrieve the outcome.",
	interactive: "secure",
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: "string",
				description: "A short, human-readable label identifying the agent (e.g. 'File Explorer')."
			},
			systemPrompt: {
				type: 'array',
				items: {
					oneOf: [
						{
							type: "object",
							properties: {
								type: { const: "file" },
								path: { type: "string" }
							}
						},
						{
							type: "object",
							properties: {
								type: { const: "text" },
								text: { type: "string" }
							}
						}
					]
				}
			},
			userMessage: { type: 'string', },
			tools: {
				type: "array",
				items: { type: "string" },
			},
			/*fileAccess: {
				enum: ["inherit", "childPath", "disabled"],
				default: "inherit"
			},
			childPath: {
				type: "string"
			},*/
			model: {
				enum: ["inherit", "fast", "balanced", "precise"],
				default: "inherit"
			},
			responseSchemaPath: { type: "string", },
			async: {
				type: "boolean",
				default: false,
			},
		},
		required: ['name', 'userMessage', 'tools'],
	},
	async script(par, ctx, conv) {
		await createSubagentWrapper(ctx, par, conv);
		const loop = subagentLoopWrapper(ctx);
		if (par.async) return "Agent started, agentId="+ctx.agentId;
		return ctx.content = await loop;
	},
	title(req, ctx) {
		const par = getToolParameters(ctx, req);
		return "子代理 ["+par.name+"]";
	},
	keyFunc(keys, context) {
		const id = context.agentId;
		if (id) {
			keys.push(id);
			const conversation = findConversation(context);
			keys.push(conversation?.time);
			keys.push(context.content);
		}
	},
	renderer(ctx, has_successor, tc, message) {
		if (ctx.time == null || ctx.success === false) return;
		const par = getToolParameters(ctx, tc);

		const evaluate = async () => {
			$update(updateMessageUI);

			const conv = unconscious(selectedConversation);
			const msg = unconscious(messages);

			if (!ctx.agentId) {
				await createSubagentWrapper(ctx, par, conv);
				// fire and forgot
				markMessageDirty(message);
				updateConversation(conv, msg);
			}

			let promise = subagentLoopWrapper(ctx);

			if (par.async) {
				ctx.success = true;
				ctx.content = "Agent started, agentId="+ctx.agentId;
			} else {
				try {
					ctx.content = await promise;
					ctx.success = true;
				} catch (e) {
					ctx.success = false;
					ctx.content = "Error: "+prettyError(e);
				}
				ctx.duration = findConversation(ctx).time - ctx.time;
			}
			markMessageDirty(message);
			$update(updateMessageUI);
		};

		// 尚未启动：没有 agentId 或 conversation 丢失
		// 前者应该不可能触发但保留
		const subagentConv = findConversation(ctx);
		if (!ctx.agentId || (!has_successor && !subagentConv)) {
			return <div className={`subagent-card`}>
				<button className="sa-btn paused" onClick={() => {
					delete ctx.agentId;
					delete ctx.content;
					evaluate();
				}}>🚀 启动
				</button>
				<span className="spacer"></span>
				{par.tools?.length > 0 && <span title={"工具:\n" + par.tools.join('\n')}>🛠 {par.tools.length}</span>}
				{par.responseSchemaPath && <span title={"结构化输出"}>📐</span>}
			</div>;
		}

		const trigger = $state();
		const updateStatus = () => $update(trigger);
		const status = $asyncState(async () => {
			if (runningConversations.has(ctx.agentId)) return [ 'running', '运行中' ];

			const status = await QueryAgentStatus.script(ctx);
			if (status === 'no such agent') return [ 'error', '已删除' ];
			if (status.startsWith('done') && ctx.content) return [ 'done', '已完成' ];
			if (status.startsWith('error')) return [ 'error', '错误' ];
			return [ 'paused', '继续' ];
		}, trigger);

		const dom = <div className={`subagent-card`}>
			{<button className={() => `sa-btn ${status[0]}`} disabled={() => {
				const type = status[0];
				return type === 'running' || type === 'done' || type === 'error';
			}} onClick={evaluate}>{() => status[1]}</button>}
			<span className="spacer"></span>
			{par.tools?.length > 0 && <span title={"工具:\n" + par.tools.join('\n')}>🛠 {par.tools.length}</span>}
			{par.responseSchemaPath && <span title={"结构化输出"}>📐</span>}
			{subagentConv && <button className={"btn ghost"} onClick={() => {
				switchToConversation(subagentConv);
			}}>转到子代理会话 #{ctx.agentId}</button>}
		</div>;

		// 代理 $cleanup
		$watch(updateMessageUI, updateStatus);
		$cleanup(dom, [updateMessageUI, updateStatus]);
		return dom;
	}
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const QueryAgentStatus = {
	name: 'QueryAgentStatus',
	description:
		"Poll the current state of a agent identified by its `agentId`. " +
		"Returns one of: 'running' (still working), 'error' (terminated with an error), or 'done' (completed successfully).",
	parameters: {
		type: 'object',
		properties: {
			agentId: {
				type: 'integer',
				description: "The numeric ID of the subagent to query, as returned by CreateAgent."
			},
			timeout: {
				type: 'integer',
				description: "Blocking timeout in seconds for agent to finish. Omit to return immediately non-blocking."
			}
		},
		required: ['agentId'],
	},
	title(tc, ctx) {
		const par = getToolParameters(ctx, tc);
		return par.timeout ? "等待子代理 #"+par.agentId+` 完成 (${par.timeout} 秒)` : "查询子代理 #"+par.agentId+" 状态";
	},
	async script(par, resp, conv) {
		const conversation = findConversation(par);
		if (!conversation) return 'no such agent';

		const timeout = par.timeout;
		if (timeout) {
			await Promise.race([
				new Promise((resolve) => setTimeout(resolve, timeout * 1000)),
				subagentLoopWrapper(par)
			]);
		}

		const lastUpdate = ((Date.now() - conversation.time) / 1000) .toFixed(1)+"s ago";

		if (runningConversations.has(par.agentId)) return 'running, lastUpdate='+lastUpdate;

		const content = subagentLoopWrapper(par).catch(e => "Error: "+prettyError(e));

		const messages = await getMessagesCacheFirst(conversation);
		const lastMessage = messages.at(-1);
		const finishReason = lastMessage.finish_reason;
		if (finishReason !== 'stop') {
			if (finishReason === "error") return 'error, lastUpdate='+lastUpdate;
			if (!lastMessage.tool_calls?.find(item => item.function.name === 'AgentFinish')) {
				return 'running('+finishReason+'), lastUpdate='+lastUpdate;
			}
		}

		return 'done: '+lastUpdate+'\n'+await content;
	},
};

const agentFinishParameter = {
	type: 'object',
	properties: {
		// 这个给 schema 之前的自动验证代码看。
		result: { type: "value" }
	},
	required: ['result'],
};
const AgentFinish = {
	name: 'AgentFinish',
	default: true,
	description: "Signal that agent has completed its task.",
	parameters: agentFinishParameter,
	script(par, resp, conv) {}
};

const AGENT_FINISH_CACHE = debugSymbol("SA_CHILD_FINISH");

registerToolset(
	"Subagent",
	"Create agents to autonomously execute a task and return the result. The agent has its own system prompt and tool set, and can optionally produce structured output via a JSON Schema.",
	[CreateSubagent, QueryAgentStatus],
	{
		default: true
	}
);

registerToolset(
	"Subagent/Child",
	"",
	[AgentFinish],
	{
		hidden: true,
		systemPrompt(conv, tools) {
			const schema = conv.sa_schema;
			if (schema) {
				let tool = conv[AGENT_FINISH_CACHE];
				if (!tool) {
					const par = structuredClone(agentFinishParameter);
					par.properties.result = schema;

					conv[AGENT_FINISH_CACHE] = tool = {
						type: "function",
						function: {
							name: AgentFinish.name,
							description: AgentFinish.description,
							parameters: par
						}
					};
				}
				tools.push(tool);
			}
		}
	}
);
