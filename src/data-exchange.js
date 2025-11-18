import {conversations, messages, selectedConversation} from "./states.js";
import {showToast} from "./Toast.js";
import {getMessages, newConversation, setConversation} from "./idb.js";
import {prettyError} from "./utils.js";

export async function importConversation(e) {
	const f = e.target.files?.[0];
	if (!f) return;

	try {
		const text = await f.text();
		/**
		 * @type {{
		 *     conversation: AiChat.Conversation | {messages: AiChat.Message[]}
		 * }}
		 */
		const data = JSON.parse(text);
		/*if (data.config) {
			Object.assign(config.value, data.config);
			showToast('配置已导入');
		}*/

		if (data.conversation) {
			const convData = data.conversation;
			const newConv = await newConversation();
			newConv.title = convData.title || '';
			newConv.time = convData.time || Date.now();
			await setConversation(newConv, convData.messages || []);
			conversations.value.unshift(newConv);
			selectedConversation.value = newConv;
			showToast('对话已导入', 'ok');
		} else {
			showToast('无对话数据');
		}
	} catch (e) {
		console.error(e);
		showToast('导入失败: ' + prettyError(e), 'error');
	} finally {
		e.target.value = '';
	}
}

export async function exportConversation() {
	const conv = selectedConversation.value;
	if (!conv) {
		showToast('无对话选中', 'error');
		return;
	}

	try {
		const data = {
			meta: {app: UC_PERSIST_STORE, version: 2},
			//config: config.value,
			title: conv.title,
			time: conv.time,
			messages: messages.value || await getMessages(conv.messageId)
		};

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