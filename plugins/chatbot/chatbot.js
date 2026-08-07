// 聊天软件接口
import {registerToolset, runTools, TOOL_NAME, tools, toolScriptRegistry, toolset} from "/src/toolset.js";
import {SETTINGS} from "/src/settings.js";
import {config, conversations, messages} from "/src/states.js";
import {agentLoop} from "/src/api-request.js";
import {$stampLock, $state, $unwatch, $watch} from "unconscious";
import {renderMarkdownToString} from "/src/markdown/markdown.js";
import {showToast} from "/src/components/Toast.js";
import {throttled} from "/src/utils/pure-utils.js";
import {getMessagesCacheFirst} from "/src/database.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {fileAccess} from "../tools/fileAccess.js";
import {onLoad} from "../../src/hooks.js";

/** @type {AiChat.FunctionTool} */
const SendMessage = {
	name: "SendMessage",
	description: "Send message to the user. Use this tool to send media files, or reference previous messages. For other text replies, you can output directly.",
	parameters: {
		type: "object",
		properties: {
			type: { enum: ["text", "image", "voice", "video", "file"], },
			content: {
				type: "string",
				description: "Text content for 'text' type, path or network URL for other types, URL is determined by http(s) prefix."
			},
			referenceMessage: {
				type: "string",
				description: "Message ID to (mention / reference / reply to)."
			},
		},
		required: ["type", "content"]
	},
	script({ type, content, referenceMessage }) {
		return chatbotInstance.send(type, content, referenceMessage);
	}
};

/** @type {AiChat.FunctionTool} */
const ListTools = {
	name: "ListTools",
	description: "List all tools subagents can use.",
	script({ searchTerms }) {
		let prompt = 'MCP工具 (名称为 MODULE:XXX 而不是 XXX)\n\n';

		const myTools = [];
		for (const key in toolset) {
			const val = toolset[key];
			if (val.hidden === true) continue;

			if (val.data === 'MCP') prompt += "MODULE:"+key+" - "+val.description+"\n\n";
			else if (!val.hidden && val.tools) myTools.push(...val.tools);
		}

		prompt += '独立工具\n\n';
		for (const key of myTools) {
			const val = tools[key];
			if (toolScriptRegistry[key]?.interactive === true && key !== 'SetTimeout')
				continue;
			prompt += key+" - "+val.function.description+"\n\n";
		}

		return prompt.trim();
	}
};

const binaryRead = fileAccess("readRaw");

registerToolset("Chatbot", "将该对话接入聊天机器人", [SendMessage, ListTools], {
	hidden: "manual",
	onActivated(conv) {
		config.chatbot_cid = conv.id;
		return [SendMessage.name, ListTools.name, "Read", "Glob", "Grep", "Write", "Stat", "Append", "Edit", "Patch", "Delete", "CopyMove", "Mkdir", "RunJS"]
	},
	async systemPrompt(conv) {
		if (conv.id !== config.chatbot_cid)
			throw '该对话已经不是 chatbot_cid, 请关闭此功能';
		return ``
	}
});

/**
 * @type {Chatbot}
 */
let chatbotInstance;

const renderItem = item => {
	if (item.kind === "text") return item.text;
	const m = item.media || {};
	const name = m.metadata?.fileName || item.kind;
	/*if (item.kind === "image" && m.url) return `![图片 ${name}](${m.url})`;
	if (item.kind === "video" && m.url) return `[视频 ${name}](${m.url})`;
	if (m.url) return `[文件 ${name}](${m.url})`;*/
	return `媒体文件: `+JSON.stringify(m);
};

class Chatbot {
	#ws;
	#userId;
	#contextToken;

	#rpcId = 0;
	#rpc = new Map;

	#conversationId;
	#conversation;
	#messages;
	#lock;
	#delaySend;

	constructor(convId) {
		this.#conversationId = convId;
		this.#delaySend = throttled(() => this.loop(), 5000);
	}

	async connect(url) {
		const st = $state(`正在连接 ${url} ...`);
		const closeToast = showToast(st, '', 0);

		const sock = new WebSocket(url);
		this.#ws = sock;

		sock.onopen = () => {
			st.value = (`✅ 连接成功`);
			closeToast();
		};
		sock.onmessage = (ev) => {
			let msg;
			try { msg = JSON.parse(ev.data); } catch { return; }
			this.#onMessage(msg);
		};
		sock.onclose = (e) => {
			if (this.#ws === sock) this.#ws = null;
			st.value = (e.code === 4003 ? "账号未登录/加载失败" : "连接已断开");
			closeToast();
		};
		sock.onerror = () => {};
	}

	send(type, content, ref) {
		return new Promise((resolve, reject) => {
			const id = this.#rpcId++;
			this.#rpc.set(id, [resolve, reject]);

			let data;
			if (type === 'text') {
				data = {type, text: content};
			} else {
				data = {
					type,
					url: content,
					//filename: ""
				};
			}

			this.#ws.send(JSON.stringify({
				type: "send", id,
				// 或者直接在连接状态中保存也行（？）
				userId: this.#userId,
				contextToken: this.#contextToken,
				data
			}));
		});
	}

	async #initialize() {
		let conversation = this.#conversation;
		if (!conversation) {
			const convId = this.#conversationId;
			this.#conversation = conversation = conversations.find(item => item.id === convId);
			if (!conversation) throw new Error("找不到对话 #"+convId);
		}

		const msgs = await getMessagesCacheFirst(conversation);
		if (msgs !== this.#messages) {
			this.#messages = msgs;
			this.#lock = $stampLock(messages, msgs);
		}
	}

	async loop() {
		await this.#initialize();
		const conversation = this.#conversation;
		const messages = this.#messages;
		const lock = this.#lock;

		let result = messages.at(-1)?.finish_reason;
		if (result === 'stop') return;

		do {
			result = await agentLoop(conversation, lock);
			if (result === 'stop' || result === 'tool_calls' || result === 'interrupt') {
				const am = messages.at(-1);
				let textContent = am.content && renderMarkdownToString(am.content, true);

				if (am.tool_responses) {
					const toolCalls = am.tool_calls;
					for (let i = 0; i < toolCalls.length; i++){
						const tc = toolCalls[i];
						const ctx = am.tool_responses[i];
						let name = ctx[TOOL_NAME];
						const secure = toolScriptRegistry[name]?.interactive === 'secure';
						try {
							const title = toolScriptRegistry[name]?.title?.(tc, ctx);
							if (title) name = title;
						} catch (e) {
							console.error("工具标题生成异常", e);
						}
						textContent += '\n调用工具: '+name;
						if (secure) textContent += " (需要审批)";
					}
				}

				if (textContent) {
					await this.send("text", textContent).catch(err => {
						messages.push({
							time: Date.now(),
							role: "user",
							content: `<system-remainder>Error: faield to send message to user: ${err}</system-remainder>`
						})
					});
				}
			}
		} while (result === 'tool_calls');
		return result;
	}

	async #onMessage(msg) {
		if ('id' in msg) {
			const rpc = this.#rpc.get(msg.id);
			if (!rpc) {
				showToast("[Chatbot] 无效的RPC ID "+msg.id, "error");
			} else {
				this.#rpc.delete(msg.id);
				if (msg.error) {
					rpc[1](msg.error);
				} else {
					rpc[0](msg.data);
				}
			}
			return;
		}

		switch (msg.type) {
			case "ready":
				this.#userId = msg.userId;
				this.#contextToken = msg.contextToken;
			break;
			case "message": {
				this.#userId = msg.fromUserId;
				this.#contextToken = msg.contextToken;

				const d = msg.messages;
				const who = `${msg.groupId ? `群 ${msg.groupId}` : msg.fromUserId}(${msg.toUserId})`;

				await this.#initialize();
				const conversation = this.#conversation;
				const messages = this.#messages;
				const lock = this.#lock;

				const str = d.length === 1 && d[0].kind === 'text' ? d[0].text : d.map(renderItem).join("\n\n");

				if (str.startsWith("/")) {
					const cmd = str.slice(1);
					if (cmd === 'deny') {
						runTools(messages.at(-1), conversation, true, false).then(() => {
							this.loop();
						});
					} else if (cmd === 'allow') {
						runTools(messages.at(-1), conversation, true, true).then(() => {
							this.loop();
						});
					} else if (cmd === 'regen') {
						if (lock.at(-1)?.role === 'assistant')
							lock.pop();
						this.loop();
					} else {
						this.send('text', `指令帮助：
/allow 允许工具调用
/deny 拒绝工具调用 (或者直接输入任意回复，默认拒绝)
/regen 重新生成回复`)
					}
					return;
				}

				lock.push({
					role: "user",
					time: msg.timestamp,
					content: str
				});

				this.#delaySend();
				break;
			}
		}
	}
}

async function connectChatbotServer() {
	if (!chatbotInstance) {
		const bot = new Chatbot(config.chatbot_cid);
		await bot.connect(config.chatbot_ws_url).then(() => {
			chatbotInstance = bot;
		});
	}
}

COMMAND_REGISTRY['ccc'] = [
	async () => {
		await connectChatbotServer();
		chatbotInstance.loop();
	},
	"连接聊天服务器"
]

onLoad(() => {
	const handler = () => {
		$unwatch(conversations, handler);
		connectChatbotServer();
	}
	if (config.chatbot_ws_url) $watch(conversations, handler, false);
});

SETTINGS.push({
	id: "chatbot_ws_url",
	name: "Chatbot WebSocket 服务器地址",
	type: "input",
}, {
	id: "chatbot_cid",
	name: "Chatbot 绑定到的对话ID",
	type: "input"
});