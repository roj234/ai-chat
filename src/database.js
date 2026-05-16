import {debugSymbol} from 'unconscious';
import {config} from "./states.js";
import {deepEqual} from "unconscious/common/deepEqual.js";
import {prettyError} from "./utils/utils.js";
import * as idb from "./database/db-indexeddb.js";
import * as remote from "./database/db-remote.js";
import {showToast} from "./components/Toast.js";
import {SETTINGS} from "./settings.js";
import {BM} from "./utils/BranchManager.js";
import {LOCKED} from "./components/ConversationList.jsx";

const MESSAGE_IN_DB = debugSymbol("MESSAGE_IN_DB");
const CONVERSATION_IN_DB = debugSymbol("CONVERSATION_IN_DB");
export const DONE = Promise.resolve();

const databaseError = err => {
	showToast("数据库错误!\n"+prettyError(err)+"\n未保存的更改可能丢失，请直接从页面导出", 'error', 0);
	return [];
};

if (DB_MODE !== 'local') {
	SETTINGS.push({
		id: "db_server",
		_tab: ["general", "data"],
		name: "数据库服务器",
		title: "提供文件管理、消息搜索、多租户等功能\n修改后需要刷新页面"+(DB_MODE === "mixed" ? "\n填写 :idb: 使用本地数据库" : ""),
		type: "input",
		pattern: (DB_MODE === "mixed" ? /^(?:(?:https?:\/\/)?.*\/api\/v2\/?|:idb:$)/ : /^(?:https?:\/\/)?.*\/api\/v2\/?/),
		warning: "请输入合法的服务器地址",
		placeholder: "/api/v2/username"
	});
}

export const isIDB = DB_MODE === 'local' || config.db_server === ':idb:';

const db = isIDB ? idb : remote;

export const {
	deleteDatabase,
	getKV, setKV,
	kvListGetValues, kvListSet, kvListDel, kvListGetKeys, kvListGet,
	searchMessages,
	updateBlob, getBlob
} = db;

/**
 * 列出所有会话，按创建时间降序
 * @returns {Promise<Array<{id:number, title:string, time:number, messageId?:number}>>}
 */
export const listConversations = async () => {
	try {
		const conversations = await db.listConversations();
		conversations.forEach((conversation) => {
			conversation[CONVERSATION_IN_DB] = structuredClone(conversation);
			conversation.ready = false;
		});
		return conversations;
	} catch (e) {
		return databaseError(e);
	}
};

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = conversation => {
	if (conversation.ready == null) return Promise.resolve([]);

	return db.getMessages(conversation).then(messages => {
		/**
		 * @type {Map<number, string>}
		 */
		const m = new Map();
		conversation[MESSAGE_IN_DB] = m;

		for (let message of messages) {
			delete message.owner;
			m.set(message.id, structuredClone(message));
		}

		return messages;
	});
};

const IGNORE_ID = new Set(["id", "ready", "bm_leaf"]);

// TODO conversation.ready 切到这个，但是用符号不会触发响应式更新
export const READY = debugSymbol("ready");

/**
 * 更新会话
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]|false=} messages
 * @param {boolean=} keepTime
 * @returns {Promise<void>}
 */
export const updateConversation = async (conversation, messages, keepTime) => {
	if (config.debugDatabase || conversation[LOCKED]) return;

	let promises = [];
	let changed = () => {
		conversation[CONVERSATION_IN_DB] = structuredClone(conversation);
		const {ready, ...omit} = conversation;
		const updateAndThen = db.upsertConversation(omit);
		promises.push(updateAndThen);
		changed = null;
		return updateAndThen;
	};

	if (!("id" in conversation)) {
		conversation[MESSAGE_IN_DB] = new Map;
		const promise = changed().then(id => {
			conversation.id = id;
		});
		if (isIDB) await promise;
	}

	if (messages) {
		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInDB = conversation[MESSAGE_IN_DB];
		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInMemory = new Map();

		if (conversation[BM]) messages = conversation[BM].messages;

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			const id = message.id;
			if (id === -1) continue;

			if (id) {
				const existingKey = messagesInDB.get(id);
				messagesInDB.delete(id);

				if (deepEqual(existingKey, message, IGNORE_ID)) {
					messagesInMemory.set(id, existingKey);
					continue;
				}
			}

			if (!keepTime && changed) {
				conversation.time = Date.now();
				changed();
			}
			const newMessageKey = structuredClone(message);
			if (id) messagesInMemory.set(id, newMessageKey);

			function save() {
				const value = {
					...message,
					owner: conversation.id
				};
				if (message.id == null) message.id = -1;

				return db.upsertMessage(value).then((id) => {
					message.id = id;
					// Async callback
					conversation[MESSAGE_IN_DB].set(id, newMessageKey);
					if (message.time !== value.time) return save();
				}).finally(() => {
					if (message.id === -1) delete message.id;
				})
			}
			promises.push(save());
		}

		if (messagesInDB) {
			messagesInDB.forEach((value, id) => promises.push(db.deleteMessage(id)));
		}

		conversation[MESSAGE_IN_DB] = messagesInMemory;
	}

	if (changed && !deepEqual(conversation[CONVERSATION_IN_DB], conversation, IGNORE_ID)) changed();

	await Promise.all(promises).catch(databaseError);
};

/**
 * 删除会话及其所有消息
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<void>}
 */
export const deleteConversation = conversation => {
	if (config.debugDatabase) return DONE;
	return db.deleteConversation(conversation.id);
};

/**
 *
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export const appendBillingLog = log => {
	if (config.debugDatabase) return DONE;
	return db.appendBillingLog(log);
};

export const getBillingLog = id => {
	if (id == null) return DONE;
	return db.getBillingLog(id);
};