// 聊天软件接口
import {
	getToolInteractiveLevel,
	getToolName,
	registerToolset,
	runTools,
	toolInfo,
	toolScriptRegistry,
	toolset
} from "/src/toolset.js";
import {conversations, EVENT_BUS, findConversation, messages, switchToConversation} from "/src/states.js";
import {agentLoop} from "/src/api-request.js";
import {$stampLock, $state, $unwatch, $watch} from "unconscious";
import {renderMarkdownToString} from "/src/markdown/markdown.js";
import {showToast} from "/src/components/Toast.js";
import {throttled} from "/common/pure-utils.js";
import {getMessages} from "/src/database.js";
import {onLoad} from "/src/hooks.js";
import {duplicateConversation} from "/src/data-exchange.js";
import {prettyError} from "/src/utils/utils.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {debugSymbol} from "@roj234/shared";

const BOT = debugSymbol("Chatbot");

/** @type {AiChat.FunctionTool} */
const SendMessage = {
	name: "SendMessage",
	description: "Send message to the user. Use this tool to send media files, or reference previous messages. For text-only replies, you can output directly.",
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
	script({ type, content, referenceMessage }, _, conv) {
		return conv[BOT].send(type, content, referenceMessage);
	}
};

/** @type {AiChat.FunctionTool} */
const ListTools = {
	name: "ListTools",
	description: "List all tools agents can use.",
	script({ searchTerms }) {
		let prompt = 'MCP工具 (传参时必须加 MCP: 前缀) \n\n';

		const myTools = [];
		for (const key in toolset) {
			const val = toolset[key];
			if (val.hidden === true) continue;

			if (val.data === 'MCP') prompt += "MCP:"+key+" - "+val.description+"\n\n";
			else if (!val.hidden && val.tools) myTools.push(...val.tools);
		}

		prompt += '独立工具\n\n';
		for (const key of myTools) {
			const val = toolInfo[key];
			if (toolScriptRegistry[key]?.interactive === true && key !== 'Wait')
				continue;
			prompt += key+" - "+val.function.description+"\n\n";
		}

		return prompt.trim();
	}
};

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

	connect(url) {
		return new Promise((resolve, reject) => {
			const st = $state(`正在连接 ${url} ...`);
			const closeToast = showToast(st, '', 0);

			const sock = new WebSocket(url);
			this.#ws = sock;

			sock.onopen = () => {
				st.value = (`✅ 连接成功`);
				closeToast();
				resolve();
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
			sock.onerror = () => reject();
		})
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
			this.#conversation = conversation = findConversation(convId);
			if (!conversation) throw new Error("找不到对话 #"+convId);
		}

		const msgs = await getMessages(conversation);
		if (msgs !== this.#messages) {
			this.#messages = msgs;
			this.#lock = $stampLock(messages, msgs);
		}
	}

	async destroy() {
		this.#ws.close();
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

				let error = am.error;
				if (!error) {
					if (result === 'interrupt') error = "你中断了生成";
					if (result === 'length') error = "达到最大输出长度";
				}
				if (error) textContent += '\n\n发生错误：\n'+prettyError(error);

				if (am.tool_responses) {
					const toolCalls = am.tool_calls;
					for (let i = 0; i < toolCalls.length; i++){
						const tc = toolCalls[i];
						const ctx = am.tool_responses[i];
						let name = getToolName(ctx, tc);
						const secure = getToolInteractiveLevel(ctx, tc, conversation) === 'secure';
						try {
							const title = toolScriptRegistry[name]?.title?.(tc, ctx);
							if (title) name = title;
						} catch (e) {
							console.error("工具标题生成异常", e);
						}
						if (secure) textContent += `

工具需要审批: ${name}
输入 /allow 允许
注：永远允许需要在UI中修改
输入其它内容拒绝`;
					}
				}

				if (textContent) {
					await this.send("text", textContent.trim()).catch(err => {
						messages.push({
							time: Date.now(),
							role: "user",
							label: "消息发送失败回执",
							content: `<system-remainder>Error: cannot send message: ${err}</system-remainder>`
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
					if (cmd === 'new') {
						const firstMessage = messages[0];
						const conv = await duplicateConversation(true);
						await switchToConversation(conv);
						delete conversation.meta.bot;
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
/new 开启新会话 (尚未实现！！)`)
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

registerToolset("Chatbot", "将该对话接入聊天机器人", [SendMessage, ListTools], {
	hidden: "manual",
	onActivated(conv) {
		return new Promise((resolve, reject) => {
			SimpleModal({
				title: "输入服务器地址",
				message: "WIP，没有输入校验，如果要改，你需要重新打开此功能",
				type: "input",
				confirmMessage: "连接",
				async onConfirm(server) {
					const bot = new Chatbot(conv.id);
					try {
						await bot.connect(server);
					} catch (e) {
						return false;
					}

					(conv.meta ??= {}).bot = {server}
					resolve();
				},
				onCancel: reject
			})
		})
	},
	onDeactivated(conv) {
		delete conv.meta.bot;
		conv[BOT]?.destroy();
	}
});

onLoad(() => {
	const handler = () => {
		$unwatch(conversations, handler);
		for (const conv of conversations) {
			const cfg = conv.meta?.bot;
			if (cfg) {
				const instance = new Chatbot(conv.id);
				conv[BOT] = instance;
				instance.connect(cfg.server).then(() => {
					EVENT_BUS.on(['convDel', conv.id], () => instance.destroy());
					return instance.loop();
				});
			}
		}
	}
	$watch(conversations, handler, false);
});
