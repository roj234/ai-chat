import {getToolParameters, registerTools} from "/src/skills.js";
import {getMessages, updateConversation} from "/src/database.js";
import {agentLoop} from "/src/api-request.js";
import {$asyncState, $update, debugSymbol, unconscious} from "unconscious";
import {config, conversations, messages, runningConversations, selectedConversation} from "/src/states.js";
import {fileAccess} from "./agent.js";
import {compileSchema} from "unconscious/common/json-schema-utils.js";
import {updateMessageUI} from "../../src/components/MessageList.jsx";

const readFile = fileAccess("read");

const CURRENT_TASK = debugSymbol("REENTRANT_LOCK");
const CONVERSATION_CACHE = debugSymbol("CONVERSATION_CACHE");

/**
 *
 * @param par
 * @param response
 * @param conv
 * @returns {Promise<void>}
 */
async function createSubAgent(par, response, conv) {
	let submitArgParameter;
	const responseSchemaPath = par.responseSchemaPath;
	if (responseSchemaPath) {
		const text = await readFile({
			path: responseSchemaPath,
			noTruncate: true
		}, response, conv);
		const schema = JSON.parse(text);
		compileSchema(schema, true);

		submitArgParameter = structuredClone(agentFinishParam);
		submitArgParameter.properties.result = schema;
	}

	/**
	 * @type {AiChat.Conversation}
	 */
	const conversation = {
		title: "子代理 " + par.label + " for #" + conv.id,
		time: Date.now(),
		fs_type: conv.fs_type,
		fs_base: conv.fs_base,
		overrides: {
			tools: submitArgParameter ? [{
				type: "function",
				function: {
					name: AgentFinish.name,
					description: AgentFinish.description,
					parameters: submitArgParameter
				}
			}] : true,
			maxToolTurns: 0,
			permittedTools: ['*'],
			ignoreToolError: true,
			sound: false
		},
		allowedTools: new Set(par.tools),
		activatedModules: new Set
	};

	const promptFromFile = par.systemPromptPath ? await readFile({
		path: par.systemPromptPath,
		noTruncate: true
	}, response, conv) : "";
	const promptStructuredOutput = responseSchemaPath ? `<structured-output>
You MUST call the \`AgentFinish\` tool to complete your task, providing your final result conforming to the specified JSON Schema.
Do NOT stop or return results in any other way — only \`AgentFinish\` signals task completion.
</structured-output>` : "";

	/**
	 *
	 * @type {OpenAI.Message[]}
	 */
	const initMessages = [];
	initMessages.push({
		role: 'system',
		content: promptFromFile + par.systemPrompt + promptStructuredOutput,
	}, {
		role: 'user',
		content: par.userMessage
	});

	await updateConversation(conversation, initMessages);
	conversations.unshift(conversation);
	response.agentId = conversation.id;
	response[CONVERSATION_CACHE] = conversation;

	return updateConversation(conv, unconscious(messages));
}

function findConversation(response) {
	return response[CONVERSATION_CACHE] || (response[CONVERSATION_CACHE] = conversations.find(item => item.id === response.agentId));
}

/**
 * @type {AiChat.FunctionTool<*>}
 */
const CreateSubagent = {
	name: 'CreateAgent',
	description:
		"Creates a agent to autonomously execute a task and return the result. " +
		"Equip it with all tools needed to complete the task. " +
		"If both 'systemPromptPath' (file) and 'systemPrompt' (text) are provided, they are concatenated - " +
		"the file content comes first, followed by the inline text. " +
		//"\nThe agent MAY operate in blocking mode (the call waits for the agent to finish)" +
		//" or non‑blocking mode (the call returns immediately with an agentId; use QueryAgentStatus to poll and retrieve the outcome)." +
		"If 'responseSchemaPath' (JSON Schema file) is provided, the agent's result will conform to that schema.",
	interactive: true,
	parameters: {
		type: 'object',
		properties: {
			name: {
				type: "string",
				description: "A short, human-readable label identifying the agent (e.g. 'File Explorer')."
			},
			systemPromptPath: { type: 'string', },
			systemPrompt: { type: 'string', },
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
		},
		required: ['name', 'userMessage', 'tools'],
	},
	async script(par, response, conv) {
		if (response[CURRENT_TASK]) return;

		if (!response.agentId) {
			await (response[CURRENT_TASK] = createSubAgent(par, response, conv));
			delete response[CURRENT_TASK];
		}

		const conversation = findConversation(response);
		const messages_ = await getMessages(conversation);
		let lastMessage = messages_.at(-1);

		ok:
		if (lastMessage.finish_reason !== 'stop') {
			let result;
			do {
				$update(updateMessageUI);
				result = await agentLoop(conversation, messages_, config, true);
			} while (result === 'tool_calls');

			if (result === false) {
				const tool = messages_.at(-2).tool_calls?.find(item => item.function.name === 'AgentFinish');
				if (tool) {
					lastMessage = messages_[messages_.length - 1] = {
						role: 'assistant',
						finish_reason: 'stop',
						content: tool.function.arguments
					};
					await updateConversation(conversation, messages_);
					break ok;
				}
			} else if (result !== 'stop') {
				throw 'unknown state '+result;
			} else {
				lastMessage = messages_.at(-1);
			}
		}

		return response.content = lastMessage.content;
		//`AgentId: ${conversation.id}\nStatus: ${lastMessage.finish_reason}\nResult:\n${lastMessage.content}`;
	},
	title(req, ctx = {}) {
		const par = getToolParameters(ctx, req);
		return "创建子代理 ["+par.label+"]";
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
		const evaluate = () => {
			$update(updateMessageUI);
			CreateSubagent.script(getToolParameters(resp, tc), resp, unconscious(selectedConversation))
				.then(() => resp.success = true, () => resp.success = false)
				.finally(() => $update(updateMessageUI))
		};
		if (!resp.agentId || !findConversation(resp)) {
			return <button className={"btn primary"} onClick={() => {
				delete resp.agentId;
				delete resp.content;
				evaluate();
			}}>启动子代理</button>
		} else {
			const state = $asyncState(() => QueryAgentStatus.script(resp));
			return <div>
				<div>子代理 #{resp.agentId}: {state}</div>
				<button disabled={() => {
					const st = unconscious(state) || "";
					return st === 'running' || st === 'deleted' || (st.startsWith('done') && resp.content);
				}} className={"btn primary"} onClick={evaluate}>继续</button>
			</div>
		}
	}
};

/**
 * @type {AiChat.FunctionTool<*>}
 */
const QueryAgentStatus = {
	name: 'QueryAgentStatus',
	description:
		"Poll the current state of a agent identified by its `agentId`. " +
		"Returns one of: 'running' (still working), 'paused' (waiting for input), 'error' (terminated with an error), or 'done' (completed successfully).",
	parameters: {
		type: 'object',
		properties: {
			agentId: {
				type: 'integer',
				description: "The numeric ID of the sagent to query, as returned by CreateAgent."
			},
		},
		required: ['agentId'],
	},
	async script(par, resp, conv) {
		if (runningConversations.has(par.agentId)) return 'running';

		const conversation = findConversation(par);
		if (!conversation) return 'deleted';

		const timestamp = new Date(conversation.time).toISOString();
		const messages = await getMessages(conversation);
		const finishReason = messages.at(-1).finish_reason;
		if (finishReason !== 'stop') {
			if (finishReason === "error") return 'error: '+timestamp;
			return 'pause('+finishReason+'): '+timestamp;
		}

		return 'done: '+timestamp;
	},
};

const agentFinishParam = {
	type: 'object',
	properties: {
		result: { type: "value" },
	},
	required: ['result'],
};
const AgentFinish = {
	name: 'AgentFinish',
	default: true,
	description: "Signal that agent has completed its task.",
	parameters: agentFinishParam,
	script(par, resp, conv) {}
};

export const registerSubagent = () => {
	registerTools(
		"Subagent",
		"Create agents to autonomously execute a task and return the result. The agent has its own system prompt and tool set, and can optionally produce structured output via a JSON Schema.",
		[CreateSubagent/*, QueryAgentStatus*/]
	);

	registerTools(
		"AgentFinish",
		"",
		[AgentFinish],
		{ hidden: true }
	);
}
