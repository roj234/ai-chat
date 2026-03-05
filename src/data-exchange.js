import {config, conversations, messages, selectedConversation} from "./states.js";
import {showToast} from "./Toast.js";
import {deleteDatabase, getMessages, newConversation, serializeMessage, updateConversation} from "./idb.js";
import {prettyError} from "./utils.js";

/**
 *
 * @param {Partial<AiChat.Conversation> & {messages: AiChat.Message[]}} convData
 * @param {boolean=false} batch
 * @return {Promise<AiChat.Conversation>}
 */
export async function importConversationData(convData, batch) {
	const newConv = await newConversation();
	newConv.title = convData.title || '';
	newConv.time = convData.time || Date.now();
	await updateConversation(newConv, JSON.parse(serializeMessage(convData.messages)) || []);
	if (!batch) {
		conversations.unshift(newConv);
		selectedConversation.value = newConv;
	}
	return newConv;
}

export async function importConversation(e) {
	const f = e.target.files?.[0];
	if (!f) return;

	try {
		const text = await f.text();
		/**
		 * @type {{
		 *     conversation: AiChat.Conversation & {messages: AiChat.Message[]}
		 * }}
		 */
		const data = JSON.parse(text);
		if (UC_PERSIST_STORE !== data.meta?.app) {
			if (!confirm("导入的文件格式可能有误，继续？")) {
				return;
			}
		}

		if (data.config) {
			Object.assign(config.value, data.config);
			showToast('配置已导入');
		}

		if (Array.isArray(data.messages)) {
			await importConversationData(data);
		} else if (Array.isArray(data.conversations)) {
			data.conversations.sort((a, b) => a.time - b.time);
			const all = [];
			for (const conv of data.conversations) {
				all.push(importConversationData(conv, true));
			}
			const my_conversations = await Promise.all(all);
			conversations.unshift(...my_conversations);
			conversations.sort((a, b) => b.time - a.time);
			showToast('对话已导入', 'ok');
		} else {
			showToast('无对话数据', 'error');
		}
	} catch (e) {
		console.error(e);
		showToast('导入失败: ' + prettyError(e), 'error');
	} finally {
		e.target.value = '';
	}
}

export async function duplicateConversation() {
	const conv = selectedConversation.value;
	if (!conv) {
		showToast('无对话选中', 'error');
		return;
	}

	const data = {
		...conv,
		messages: messages.value || await getMessages(conv)
	};

	await importConversationData(data);
	showToast('已将当前对话另存为', 'ok');
}

export async function exportConversation() {
	let data;

	const conv = selectedConversation.value;
	if (conv) {
		data = {
			meta: {app: UC_PERSIST_STORE, version: 2},
			title: conv.title,
			time: conv.time,
			messages: messages.value || await getMessages(conv)
		};
	} else {
		showToast('正在导出'+conversations.length+'条数据，请稍候！');
		const callbacks = [];
		const my_conversations = [];
		for (const conv of conversations) {
			const index = callbacks.length;
			callbacks.push(getMessages(conv).then(messages => my_conversations[index] = {
				...conv,
				messages
			}));
		}

		await Promise.all(callbacks);
		data = {
			meta: {app: UC_PERSIST_STORE, version: 3},
			config: config.value,
			conversations: my_conversations,
		};
	}

	try {
		const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${UC_PERSIST_STORE}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
	} catch (e) {
		console.error(e);
		showToast('导出失败: ' + prettyError(e), 'error');
	}
}

export function clearDatabase() {
	if (confirm("删除所有对话数据？")) {
		deleteDatabase().then(() => {
			location.reload();
		})
	}
}

/**
 *
 * @param {AiChat.Message[]} messages
 * @return {string}
 */
export function messagesToText(messages) {
	const lines = [];
	for (const m of messages) {
		let header = `[${m.role}]`;

		// 构建 metadata JSON（只包含非 role/content 的属性）
		const metadata = {...m};
		delete metadata.role;
		delete metadata.content;

		if (Object.keys(metadata).length) {
			header += " "+JSON.stringify(metadata);
		}

		lines.push(header+'\n'+m.content+'\n');
	}
	return lines.join('\n').trim();
}

/**
 *
 * @param {string} text
 * @return {AiChat.Message[]}
 */
export function textToMessages(text) {
	const out = [];
	if (!text) return out;

	let cur = null;

	const pushCur = () => {
		if (cur && (cur.content = cur.content.trim() || cur.tool_calls)) {
			out.push(cur);
		}
		cur = null;
	};

	for (const line of text.split('\n')) {
		// role, metadata
		const roleMatch = line.match(/^\[(system|user|assistant|tool)]\s?(\{.*})?/i);
		if (roleMatch) {
			pushCur();

			cur = roleMatch[2] ? JSON.parse(roleMatch[2]) : {};
			cur.role = roleMatch[1].toLowerCase();
			cur.content = "";
		} else {
			cur.content += line + '\n';
		}
	}

	pushCur();

	// 处理 systemPrompt
	const sp = config.systemPrompt?.trim();
	if (sp && out[0]?.role === 'system' && out[0].content === sp) {
		out.shift();
	}

	return out;
}
