import {getToolParameters, registerToolset} from "/src/toolset.js";
import {getMessages, updateConversation} from "/src/database.js";
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

const readFile = fileAccess("read");

const INIT_AGENT_SYM = debugSymbol("InitAgent");
const EVAL_AGENT_SYM = debugSymbol("EvaluateAgent");
const CONVERSATION_CACHE = debugSymbol("CONVERSATION_CACHE");

/**
 *
 * @param par
 * @param response
 * @param conv
 * @returns {Promise<void>}
 */
async function createSubAgent(par, response, conv) {
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
		// 当前未使用
		owner: conv.id,
		// 覆盖系统配置
		overrides: {
			tools: true,
			maxToolTurns: 0,
			permittedTools: ['*'],
			afkState: 1,
			sound: false
		},
		allowedTools: new Set(par.tools),
		activatedModules: new Set(['Subagent/Child'])
	};

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

	/**
	 * @type {OpenAI.Message[]}
	 */
	const initMessages = [];
	if (systemPrompt) {
		initMessages.push({
			role: 'system',
			content: systemPrompt,
		});
	} else {
		conversation.overrides.systemPrompt = '---\n---';
	}
	initMessages.push({
		role: 'user',
		content: par.userMessage
	});

	await updateConversation(conversation, initMessages);
	conversations.unshift(conversation);
	response.agentId = conversation.id;
	response[CONVERSATION_CACHE] = conversation;

	return updateConversation(conv, unconscious(messages));
}

const findConversation = response => response[CONVERSATION_CACHE] || (response[CONVERSATION_CACHE] = conversations.find(item => item.id === response.agentId));

const subagentLoop = async ctx => {
	const conversation = findConversation(ctx);
	const messages_ = await getMessages(conversation);

	let stop = messages_.at(-1).finish_reason;
	while (stop === 'tool_calls' || stop === undefined || stop === 'interrupt') {
		$update(updateMessageUI);
		stop = await agentLoop(conversation, messages_, config, true);
	}

	let content;
	if (stop === false) {
		const tool = messages_.at(-2).tool_calls?.find(item => item.function.name === 'AgentFinish');
		if (tool) {
			content = tool.function.arguments;
			messages_.pop();
			return content;
		}
	} else {
		return messages_.at(-1).content;
	}
};
const subagentLoopWrapper = ctx => {
	let promise = ctx[EVAL_AGENT_SYM];
	if (promise) return promise;
	promise = ctx[EVAL_AGENT_SYM] = subagentLoop(ctx);
	promise.finally(() => delete ctx[EVAL_AGENT_SYM]);
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
			/*blocking: {
				type: "boolean",
				default: true
			},*/
			responseSchemaPath: { type: "string", },
			async: {
				type: "boolean",
				default: false,
			},
		},
		required: ['name', 'userMessage', 'tools'],
	},
	async script(par, ctx, conv) {
		if (ctx[INIT_AGENT_SYM]) await ctx[INIT_AGENT_SYM];

		if (!ctx.agentId) {
			await (ctx[INIT_AGENT_SYM] = createSubAgent(par, ctx, conv));
			delete ctx[INIT_AGENT_SYM];
		}

		const loop = subagentLoopWrapper(ctx);
		if (par.async) return "Agent started, agentId="+ctx.agentId+", time="+new Date().toISOString();
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
	renderer(resp, has_successor, tc) {
		if (resp.time == null) return;

		const evaluate = () => {
			$update(updateMessageUI);

			const conv = unconscious(selectedConversation);
			const msg = unconscious(messages);

			CreateSubagent.script(getToolParameters(resp, tc), resp, conv)
				.then(() => {
					resp.success = true;
					updateConversation(conv, msg);
				}, () => resp.success = false)
				.finally(() => $update(updateMessageUI))
		};

		const par = getToolParameters(resp, tc);

		// 尚未启动：没有 agentId 或 conversation 丢失
		// 前者应该不可能触发但保留
		if (!resp.agentId || (!has_successor && !findConversation(resp))) {
			return <div className={`subagent-card`}>
				<button className="sa-btn paused" onClick={() => {
					delete resp.agentId;
					delete resp.content;
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
			if (runningConversations.has(resp.agentId)) return [ 'running', '运行中' ];

			const status = await QueryAgentStatus.script(resp);
			if (status === 'deleted') return [ 'error', '已删除' ];
			if (status.startsWith('done') && resp.content) return [ 'done', '已完成' ];
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
			<button className={"btn ghost"} onClick={() => {
				switchToConversation(findConversation(resp));
			}}>转到子代理会话 #{resp.agentId}</button>
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
				description: "Blocking timeout in milliseconds for agent to finish. Omit to return immediately non-blocking."
			}
		},
		required: ['agentId'],
	},
	async script(par, resp, conv) {
		const conversation = findConversation(par);
		if (!conversation) return 'deleted';

		const timeout = par.timeout;
		if (timeout) {
			await Promise.race([
				new Promise((resolve) => setTimeout(resolve, timeout)),
				subagentLoopWrapper(par)
			]);
		}

		const lastUpdate = new Date(conversation.time).toISOString();

		if (runningConversations.has(par.agentId)) return 'running, lastUpdate='+lastUpdate;

		const content = subagentLoopWrapper(par).catch(e => {
			console.info('[AgentLoop]', e);
		})

		const lastMessage = (await getMessages(conversation)).at(-1);
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
