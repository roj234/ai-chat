import {
	getAvailableTools,
	getToolParameters,
	parseFrontmatter,
	prefixTitle,
	registerToolset,
	TOOL_NAME,
	toolScriptRegistry,
} from "/src/toolset.js";
import {
	getMessagesCacheFirst,
	kvListGet,
	markCombinedPresetDirty,
	markMessageDirty,
	updateConversation
} from "/src/database.js";
import {agentLoop} from "/src/api-request.js";
import {$asyncState, $cleanup, $state, $update, $watch, debugSymbol, unconscious} from "unconscious";
import {
	config,
	conversations,
	EVENT_BUS,
	findConversation,
	LOCKED,
	messages,
	runningConversations,
	selectedConversation,
	switchToConversation,
	updateMessageUI
} from "/src/states.js";
import {fileAccess} from "./fileAccess.js";
import {compileSchema, validateAndShowError} from "unconscious/common/json-schema-utils.js";
import "./subagent.css";
import {showToast} from "/src/components/Toast.js";
import {cloneNamed, prettyError} from "/src/utils/utils.js";
import {DI, DID_SYNC_LOCK, DID_SYNC_UNLOCK} from "/src/hooks.js";
import {injectMessages} from "/src/inject-message.js";
import {SETTINGS} from "/src/settings.js";
import {createAsyncQueue} from "/common/pure-utils.js";
import schema from "./agent_definition_schema.json";
import {getSkillCache} from "./skills.js";
import {JS_HOST_MODULES, RunJS} from "./run_js.js";

compileSchema(schema);

const readFile = fileAccess("read");
const glob = fileAccess("list");
const appendFile = fileAccess("append");

const INIT_AGENT_SYM = debugSymbol("InitAgent");
const EVAL_AGENT_SYM = debugSymbol("EvaluateAgent");
const CONVERSATION_CACHE = debugSymbol("CONVERSATION_CACHE");
const FS_KEYS = ["fs_type", "fs_base", "fs_server", "fs_builtin"];
const TERMINATED_MESSAGE = '任务中止';

const findAgent = response => response[CONVERSATION_CACHE] || (response[CONVERSATION_CACHE] = findConversation(response.agentId));

const nestDepth = async (conv) => {
	let depth = 1;
	while (conv.owner != null) {
		conv = findConversation(conv.owner);
		depth++;
		await getMessagesCacheFirst(conv);
	}
	return depth;
}

/**
 * @param {AiChat.Conversation} conv
 * @param {number} target
 * @return {Promise<boolean>}
 */
const isOwned = async (conv, target) => {
	while (1) {
		await getMessagesCacheFirst(conv);
		const owner = conv.owner;
		if (owner == null) return false;
		if (owner === target) return true;
		conv = findConversation(owner);
	}
};

const findOwnAgent = async (par, conv) => {
	const agent = findAgent(par);
	if (!agent) throw 'Agent not exist';
	if (!await isOwned(agent, conv.id)) throw `Agent(${agent.id}) is not owned by current session(${conv.id})`;
	return agent;
};

/**
 * 会瞬移的乌龟 (Brent 查环，少调用几次 findConversation，它是 O(n) 的)
 * 也许之后搞个哈希表
 * @param {AiChat.Conversation} start
 * @return {Promise<boolean>}
 */
const hasLoop = async (start) => {
	let tortoise = start;
	if (null == start.owner) await getMessagesCacheFirst(start);
	let hare = findConversation(start.owner);
	if (!hare) return false;

	let power = 1, lam = 1;

	while(1) {
		if (hare === start) return true;
		if (tortoise === hare) return false;
		if (power === lam) {
			tortoise = hare;
			power <<= 1;
			lam = 0;
		}

		if (null == hare.owner) await getMessagesCacheFirst(hare);
		hare = findConversation(hare.owner);
		if (!hare) return false;

		lam++;
	}
}

/**
 *
 * @param {Object} par
 * @param {AiChat.ToolResponse} response
 * @param {AiChat.Conversation} conv
 * @param {string[]} tools
 * @returns {Promise<AiChat.Conversation>}
 */
async function createSubagent(par, response, conv, tools) {
	/**
	 * @type {AiChat.Conversation}
	 */
	const agent = {
		title: "子代理 " + par.label + " for #" + conv.id,
		time: Date.now(),
		// 有些工具比如SetTimeout判断它是否存在从而进入假设无UI的无头模式
		owner: conv.id,
		// 覆盖系统配置
		overrides: {
			maxToolTurns: 200,
			permittedTools: ['*'],
			afkState: 1,
			sound: false,
			disableFinishToast: true
		},
		tools: new Set(),
		activatedModules: new Set()
	};
	const messages = [{
		role: 'user',
		content: par.firstMessage
	}];

	const source = conv.overrides;
	if (source) Object.assign(agent.overrides, source);
	const presets = conv.presets;
	if (presets) agent.presets = presets;

	let _async = par.background;
	let hasFileSystem;
	let systemPrompt = '';
	let _skills, _kind;

	const promptType = par.promptType;
	let promptValue = par.prompt;
	if (promptType === "text") {
		systemPrompt = promptValue;
	} else {
		if (promptType === "name") {
			const indexed = (await initAgentCache(conv)).index[promptValue];
			if (indexed) promptValue = indexed;
			else throw "Named agent "+promptValue+" not found";
		}

		let [info, content] = parseFrontmatter(await readFile({
			path: promptValue,
			noTruncate: true
		}, response, conv));

		let { tools: tools1, model = 'inherit', maxToolTurns, maxTurns, redirect, mounts, skills, background, mcpServers, kind = 'basic' } = info;

		const error = validateAndShowError(info, schema.$defs.AgentDefinition);
		if (error) throw "Agent definition format error:\n"+error;

		if (model !== 'inherit') {
			try {
				const preset = await kvListGet("preset", model);
				Object.assign(agent.overrides, preset);
			} catch (e) {
				showToast("无子代理配置【"+model+"】，回落到 inherit", "", 30000);
			}
		}

		if (mounts) {
			const {'/': root, '...': rest, ...m} = mounts;
			if (root) Object.assign(agent, cloneNamed(root, FS_KEYS));

			const mnt = agent.mnt = {};
			for (const key in m) {
				mnt[key] = cloneNamed(m[key], FS_KEYS);
			}

			if (!rest) hasFileSystem = true;
		}

		// Array
		if (mcpServers) {
			const newModules = [];
			for (const key of mcpServers) {
				if (typeof key === "string")
					newModules.push(key);
				else {
					throw "Sorry add MCP servers on the fly is not supported yet";
				}
			}

			await toolScriptRegistry['Use'].script({ modules: newModules }, {}, agent);
		}

		if (background != null) {
			_async = background;
		}

		if (tools1) {
			if (typeof tools1 === 'string') tools1 = tools1.split(" ");
			tools = tools1;
		}

		if (maxToolTurns) {
			agent.overrides.maxToolTurns = parseInt(maxToolTurns);
		}

		if (maxTurns) {
			agent.sa_maxTurns = parseInt(maxTurns);
		}

		if (redirect) {
			_async = true;

			agent.sa_redirect = redirect;
			if (redirect.target === "javascript") {
				await readFile({path: redirect.path}, response, conv);
				redirect.thread = Math.random().toString(36).slice(3);
			}

			let id = redirect.id;
			if (null != id) {
				if (-1 === id) {
					id = redirect.id = par.redirectTarget;
					if (null == id) throw "redirectTarget is required for this definition";
				}

				if (0 === id) redirect.id = conv.id;
				else if (id !== conv.id) {
					const ping = findConversation(id);
					if (!ping) throw `Redirect target(${id}) not exist`;
					if (!await isOwned(ping, conv.id)) throw `Redirect target(${id}) is not owned by current session(${conv.id})`;
				}
			}
		}

		if (kind !== 'basic') {
			const promises = await EVENT_BUS.post(["createAgent", kind], agent, messages, info);
			if (!promises.length) throw "Unknown kind "+kind;
		}

		_skills = skills;
		systemPrompt = content;
	}

	if (_async) agent.sa_notify = 0;
	if (!hasFileSystem) {
		// 复制文件系统
		if (!agent.fs_type) Object.assign(agent, cloneNamed(conv, FS_KEYS));
		const mnt = conv.mnt;
		if (mnt) {
			const mnt2 = agent.mnt ?? (agent.mnt = {});
			for (const key in mnt) {
				if (!mnt2[key])
					mnt2[key] = cloneNamed(mnt[key], FS_KEYS);
			}
		}
	}

	if (_skills) {
		const index = agent.mnt?.[".skills"] && (await getSkillCache(agent)).index;
		if (typeof _skills === 'string') _skills = _skills.split(" ");

		const includes = (await Promise.all(_skills.map(path => readFile({
			path: index?.[path]?.[0] ?? path,
			noTruncate: true
		}, response, agent).then(text => `# Document ${path}\n\n`+text)))).join('\n\n');

		systemPrompt += "\n\n"+includes;
	}

	// 有些太耦合了。不过都是内置插件，大概也无所谓，但是以后肯定要改
	const modules1 = agent.activatedModules;
	const exist = modules1.has("Files");
	modules1.add("Files");
	const [tools_, toolsetPrompt] = await getAvailableTools(agent);
	if (!exist) modules1.delete("Files");

	agent.tools.clear();
	for (let t of tools) {
		if (!toolScriptRegistry[t = t.trim()])
			throw "Tool "+t+" not found";
		agent.tools.add(t);
	}

	agent.overrides.systemPrompt = (systemPrompt + toolsetPrompt) || '---\n---';

	markCombinedPresetDirty(agent);

	await updateConversation(agent, messages);

	conversations.unshift(agent);
	response.agentId = agent.id;
	response.time = Date.now();
	return response[CONVERSATION_CACHE] = agent;
}
const createSubagentWrapper = async (ctx, par, conv) => {
	let promise = ctx[INIT_AGENT_SYM];
	if (promise) return promise;

	if (!ctx.agentId) {
		if (await nestDepth(conv) > config.subagentDepth) throw "Agent recursion limit reached: "+config.subagentDepth;

		const promise = ctx[INIT_AGENT_SYM] = createSubagent(par, ctx, conv, par.tools || conv.tools);
		promise.finally(() => delete ctx[INIT_AGENT_SYM]);
		return promise;
	}
};

const subagentLoop = async conversation => {
	const messages = await getMessagesCacheFirst(conversation);
	if (conversation.sa_terminated) return { id: -1, error: true, content: TERMINATED_MESSAGE };

	let lastMessage = messages.at(-1);
	let finishReason = lastMessage.finish_reason;
	let loop_finish_reason;

	let locked;
	try {
		while (loop_finish_reason !== false && (lastMessage.role !== 'assistant' || finishReason === 'tool_calls')) {
			if (conversation[LOCKED] === "DELETED") {
				return {
					id: Infinity,
					error: true,
					content: "Session was deleted."
				}
			}

			if (!locked) {
				locked = true;
				DI[DID_SYNC_LOCK]?.(conversation.id);
				$update(updateMessageUI);
			}

			loop_finish_reason = await agentLoop(conversation, messages);
			lastMessage = messages.at(-1);
			finishReason = lastMessage.finish_reason;
		}

		if (loop_finish_reason === false) {
			finishReason = lastMessage.finish_reason = 'interrupt';
			markMessageDirty(lastMessage);
		}
	} finally {
		if (locked) DI[DID_SYNC_UNLOCK]?.(conversation.id);
	}

	await updateConversation(conversation, messages);

	const error = finishReason !== 'stop';
	let id = lastMessage.id;

	let content;
	if (error) {
		content = lastMessage.error;
		if (!content) {
			content = "Unknown error";
			if (finishReason === 'interrupt') content = "Interrupted by user";
			if (finishReason === 'length') content = "Token budget reached";
		} else if (content === TERMINATED_MESSAGE) {
			id = -1;
		}
	} else {
		content = lastMessage.content;
	}

	return {
		id,
		error,
		content
	}
};

const RETRY_ERROR = "RetryError";

/**
 *
 * @param ctx
 * @return {Promise<{id: number, error: boolean, content: string}>}
 */
export const subagentLoopWrapper = ctx => {
	const agent = findAgent(ctx);
	let promise = agent[EVAL_AGENT_SYM];
	if (promise) return promise;
	promise = agent[EVAL_AGENT_SYM] = subagentLoop(agent);
	promise.then(resp => {
		const lastNotify = agent.sa_notify;
		if (lastNotify == null) {
			agent.sa_notify = resp.id;
			return updateConversation(agent);
		}

		if (lastNotify >= resp.id) return;
		agent.sa_notify = resp.id;

		const promises = [updateConversation(agent)];

		const redir = agent.sa_redirect;

		let target;
		injectMessage: {
			if (redir) {
				const ping = (result) => injectMessages(findConversation(redir.id), {
					role: 'user',
					label: "子代理",
					time: Date.now(),
					content: `<agent-message from="${agent.id}" role="ping">\n${result}</agent-message>`,
				});

				switch (redir.target) {
					case "file": {
						let content = resp.content;
						if (resp.error) content = "Fatal Error:\n"+content;
						let p = appendFile({ path: redir.path, content }, {}, agent);
						promises.push(p.then(ping));
					}
					break injectMessage;
					case "javascript": {
						let p = RunJS.script({
							path: redir.path,
							env: {
								AGENT_ID: agent.id,
								AGENT_OWNER: agent.owner,
								AGENT_ERROR: !!resp.error,
								AGENT_RESPONSE: resp.content
							},
							timeout: 60,
							persist: true,
							thread: agent.id+"-"+redir.thread,
							throw: true
						}, {}, agent);

						promises.push(p.then(ping, e => {
							if (e?.name !== RETRY_ERROR) return ping("Script error:\n"+prettyError(e));

							return injectMessages(agent, {
								role: 'user',
								label: "错误重试",
								time: Date.now(),
								content: prettyError(e.message),
							}).then(() => subagentLoopWrapper(ctx))
						}));
					}
					break injectMessage;
					case "agent": target = findConversation(redir.id); break;
				}
			} else {
				target = findConversation(agent.owner);
			}

			promises.push(injectMessages(target, {
				role: 'user',
				label: "子代理",
				time: Date.now(),
				content: `<agent-message from="${agent.id}"${resp.error?" errored":""}>\n${resp.content}\n</agent-message>`,
			}));
		}

		return Promise.all(promises);
	});
	promise.finally(() => { delete agent[EVAL_AGENT_SYM]; });
	return promise;
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const CreateSubagent = {
	name: 'CreateAgent',
	description: "Creates an agent to autonomously execute a task and return the result.",
	interactive: "secure",
	parameters: {
		type: 'object',
		properties: {
			label: {
				type: "string",
				description: "A short, human-readable label identifying the agent (e.g. 'File Explorer')."
			},
			promptType: { enum: ["text", "file", "name"], },
			prompt: { type: "string", description: "raw text, file path or definition name based on the 'promptType'." },
			firstMessage: { type: 'string', },
			tools: {
				type: "array",
				description: "Inherit by default, emit to overwrite (whitelist)",
				items: { type: "string" },
			},
			background: {
				type: "boolean",
				default: false,
				description: "Background mode: the call returns immediately with an id; You will be notified by a <agent-message from=\"agentId\">XML Tag</agent-message> when it finishes."
			},
			redirectTarget: { type: "integer", description: "see skills document" },
		},
		required: ['label', 'promptType', 'prompt', 'firstMessage'],
	},
	async script(par, ctx, conv) {
		const start = Date.now();
		const agent = await createSubagentWrapper(ctx, par, conv);
		const loop = subagentLoopWrapper(ctx);
		if (agent.sa_notify != null) return "Agent id="+ctx.agentId+" started";

		const result = await loop;
		return ctx.content = `agentId=${ctx.agentId}, duration: ${((Date.now() - start) / 1000).toFixed(1)}s\n`+result.content;
	},
	title(req, ctx) {
		const par = getToolParameters(ctx, req);
		return "子代理 ["+par.label+"]";
	},
	keyFunc(keys, context) {
		const id = context.agentId;
		if (id) {
			keys.push(id);
			const conversation = findAgent(context);
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
			const agent = findAgent(ctx);

			if (agent.sa_notify != null) {
				ctx.success = true;
				ctx.content = "Agent id="+ctx.agentId+" started";
			} else {
				try {
					ctx.content = (await promise).content;
					ctx.success = true;
				} catch (e) {
					ctx.success = false;
					ctx.content = "Error: "+prettyError(e);
				}
				ctx.duration = agent.time - ctx.time;
			}
			markMessageDirty(message);
			$update(updateMessageUI);
		};

		// 尚未启动：没有 agentId 或 conversation 丢失
		// 前者应该不可能触发但保留
		const subagentConv = findAgent(ctx);
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

			const conversation = findAgent(ctx);
			if (!conversation) return [ 'error', '已删除' ];

			subagentLoopWrapper(ctx);

			const lastMessage = (await getMessagesCacheFirst(conversation)).at(-1);
			const finishReason = lastMessage.finish_reason;
			if (finishReason === 'tool_calls') return [ 'running', '运行中' ];
			if (finishReason !== 'stop') return [ 'error', '错误' ];
			return [ 'done', '已完成' ];
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

const doTerminate = async conversation => {
	conversation.sa_terminated = true;
	await injectMessages(conversation, {
		role: 'assistant',
		finish_reason: 'error',
		time: Date.now(),
		error: TERMINATED_MESSAGE
	});
	return "Terminated.";
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const NotifyAgent = {
	name: 'NotifyAgent',
	description: "Send message to an agent.",
	parameters: {
		type: 'object',
		properties: {
			agentId: { type: 'integer', },
			message: { type: 'string' },
		},
		required: ['agentId', 'message'],
	},
	title(req, ctx) {
		const par = getToolParameters(ctx, req);
		return "向子代理 #"+par.agentId+" 发送 "+par.message.slice(0, 50);
	},
	async script(par, resp, conv) {
		const agent = await findOwnAgent(par, conv);

		const state = runningConversations.get(par.agentId);
		const isTerminate = resp[TOOL_NAME] === TerminateAgent.name;
		if (!state) {
			subagentLoopWrapper(par);

			const messages = await getMessagesCacheFirst(agent);
			const lastMessage = messages.at(-1);
			const finishReason = lastMessage.finish_reason;
			if (finishReason !== 'stop') return `Agent was terminated (reason=${finishReason})`;

			if (isTerminate) return doTerminate(agent);
		} else {
			if (isTerminate) {
				state.abort.abort(par.message);
				return doTerminate(agent);
			}
		}

		const isDirectlyOwner = agent.owner === conv.id;

		let label = `父代理 (${conv.id})`;
		let content = par.message;

		if (!isDirectlyOwner) content = `<agent-message from=${conv.id}>\n${content}\n</agent-message>`;

		await injectMessages(agent, {
			role: 'user',
			time: Date.now(),
			label,
			content
		});
		return "Message sent";
	},
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const TerminateAgent = {
	name: 'TerminateAgent',
	description: "Terminate an agent, linger notifications will be silently discarded. Only for agents that are failing to stop by themselves.",
	parameters: {
		type: 'object',
		properties: {
			agentId: { type: 'integer', },
		},
		required: ['agentId'],
	},
	title: prefixTitle("终止子代理 #", "agentId"),
	script: NotifyAgent.script
};

SETTINGS.push({
	id: "subagentDepth",
	name: "子代理最大递归深度",
	_tab: "tools",
	type: "number",
	default: 3,
	min: 1,
	max: 10,
});

const hijackLoop = conv => {
	if (conv.owner != null) {
		subagentLoopWrapper({ agentId: conv.id });
		return false;
	}
};
EVENT_BUS.on('injectMessage', hijackLoop);
EVENT_BUS.on('loopEntry', hijackLoop);

const AGENT_CACHE = debugSymbol("AgentDefinitions");
async function initAgentCache(conv) {
	let agentCache = conv[AGENT_CACHE];
	if (!agentCache) {
		const index = {};
		let prompt = `<agents>
Available agent definitions:
---
`;

		const sortable = [];
		const [enqueue, finish] = createAsyncQueue();

		const loadDefinition = async (basePath) => {
			for (const [relPath] of await glob({
				path: basePath,
				pattern: "*.md",
				json: true
			}, 0, conv).catch(() => [])) {
				const path = basePath+"/"+relPath;
				await enqueue(async () => {
					const str = await readFile({
						path,
						format: 'frontmatter'
					}, {}, conv);

					const [metadata] = parseFrontmatter(str);
					if (!('name' in metadata)) return;

					index[metadata.name] = path;
					sortable.push(metadata)
				});
			}
		}

		await loadDefinition("agents");
		if (conv.mnt?.[".skills"]) {
			await loadDefinition("~/.skills/agents");
		}
		await finish();

		sortable.sort((a, b) => a.name.localeCompare(b.name)).forEach(metadata => {
			prompt += metadata.name+":\n"+metadata.description+"\n\n";
		});

		return conv[AGENT_CACHE] = {
			index,
			prompt: sortable.length ? prompt + '</agents>' : ''
		};
	}

	return agentCache;
}

registerToolset(
	"Subagent",
	"Create agents to autonomously execute a task and return the result.",
	[CreateSubagent, NotifyAgent, TerminateAgent],
	{
		default: true,
		async systemPrompt(conv) {
			const agentList = (await initAgentCache(conv)).prompt;
			return agentList;
			//return (agentList?agentList+'\n':'')+`<agent-id>${conv.id}</agent-id>`;
		}
	}
);

JS_HOST_MODULES["agents"] = agent => {
	const owner = findConversation(agent.owner);
	if (!owner) return {};
	return ({
		async notifyAgent(id, content) {
			let target;
			if (id === agent.owner || id === 0) {
				target = owner;
			} else {
				target = await findOwnAgent({ agentId: id }, owner);
			}

			return injectMessages(target, {
				role: 'user',
				time: Date.now(),
				label: `重定向脚本 (${agent.id})`,
				content
			});
		},
		async retry(content) {
			throw { name: RETRY_ERROR, message: content };
		}
	});
};