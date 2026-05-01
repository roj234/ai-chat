import {debugSymbol} from 'unconscious';
import {config} from "./states.js";
import {isEqual} from "../vendor/equals.js";
import {cloneNamed, prettyError} from "./utils/utils.js";
import * as idb from "./database/db-indexeddb.js";
import * as remote from "./database/db-remote.js";
import {showToast} from "./components/Toast.js";
import {SETTINGS} from "./settings.js";

const MESSAGE_IN_DB = debugSymbol("MESSAGE_IN_DB");
const CONVERSATION_IN_DB = debugSymbol("CONVERSATION_IN_DB");
export const DONE = Promise.resolve();

function databaseError(err) {
	showToast("数据库错误!\n"+prettyError(err)+"\n未保存的更改可能丢失，请直接从页面导出", 'error', 0);
	return [];
}

if (DB_MODE !== 'local') {
	SETTINGS.push({
		id: "db_server",
		name: "数据库服务器",
		title: "提供文件管理、消息搜索、多租户等功能\n修改后需要刷新页面"+(DB_MODE === "mixed" ? "\n填写 :idb: 使用本地数据库" : ""),
		type: "input",
		pattern: (DB_MODE === "mixed" ? /^(?:(?:https?:\/\/.+)?\/aichat\/v2\/?|:idb:$)/ : /^(?:https?:\/\/.+)?\/aichat\/v2\/?/),
		warning: "请输入合法的服务器地址",
		placeholder: "/aichat/v2/user"
	});
}
const db = DB_MODE === 'remote' || (DB_MODE === "mixed" && config.db_server !== ':idb:') ? remote : idb;

export const {
	deleteDatabase,
	getKV, setKV,
	kvListGetValues, kvListSet, kvListDel, kvListGetKeys, kvListGet, kvListGetByName,
	searchMessages,
	updateBlob, getBlob
} = db;

/**
 * 列出所有会话，按创建时间降序
 * @returns {Promise<Array<{id:number, title:string, time:number, messageId?:number}>>}
 */
export async function listConversations() {
	try {
		const conversations = await db.listConversations();
		conversations.forEach((conversation) => {
			conversation[CONVERSATION_IN_DB] = serializeConversation(conversation);
			conversation.ready = false;
		});
		return conversations;
	} catch (e) {
		return databaseError(e);
	}
}

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export function getMessages(conversation) {
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
	}).catch(databaseError);
}

/**
 * 新建一个会话
 * @returns {Promise<AiChat.Conversation>}
 */
export async function newConversation() {
	const conversation = {
		title: "",
		time: Date.now(),
		[MESSAGE_IN_DB]: new Map
	};

	if (config.debugDatabase) {
		conversation.id = -1;
	} else {
		await db.newConversation(conversation)
	}

	conversation[CONVERSATION_IN_DB] = serializeConversation(conversation);
	return conversation;
}

const IGNORE_ID = new Set(["id"]);

export const CONVERSATION_KEYS = ["id", "title", "time", "allowedTools", "activatedModules"];

function serializeConversation(data) {
	return cloneNamed(data, CONVERSATION_KEYS);
}

/**
 * 更新会话
 * @param {AiChat.Conversation} data
 * @param {AiChat.Message[]|false=} messages
 * @param {boolean=} keepTime
 * @returns {Promise<void>}
 */
export function updateConversation(data, messages, keepTime) {
	if (config.debugDatabase) return DONE;

	const promises = [];
	let changed;

	if (messages) {
		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInDB = data[MESSAGE_IN_DB];
		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInMemory = new Map();

		for (let i = 0; i < messages.length; i++){
			const message = messages[i];
			const id = message.id;
			if (id === -1) continue;

			if (id) {
				const existingKey = messagesInDB.get(id);
				messagesInDB.delete(id);

				if (isEqual(existingKey, message, IGNORE_ID)) {
					messagesInMemory.set(id, existingKey);
					continue;
				}
			}

			if (!keepTime) changed = true;
			const newMessageKey = structuredClone(message);
			if (id) messagesInMemory.set(id, newMessageKey);

			function save() {
				const value = {
					...message,
					owner: data.id
				};
				if (message.id == null) message.id = -1;

				return db.updateMessage(value).then(({id}) => {
					message.id = id;
					// Async callback
					data[MESSAGE_IN_DB].set(id, newMessageKey);

					if (message.time !== value.time) return save();
				})
			}
			promises.push(save());
		}

		if (messagesInDB)
			messagesInDB.forEach((value, id) => promises.push(db.deleteMessage(id)));

		data[MESSAGE_IN_DB] = messagesInMemory;
	}

	const serializedForm = serializeConversation(data);
	if (changed || !isEqual(data[CONVERSATION_IN_DB], serializedForm, IGNORE_ID)) {
		if (changed) serializedForm.time = data.time = Date.now();
		data[CONVERSATION_IN_DB] = serializedForm;
		promises.push(db.updateConversation(serializedForm));
	}

	return Promise.all(promises).catch(databaseError);
}

/**
 * 删除会话及其所有消息
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<void>}
 */
export function deleteConversation(conversation) {
	if (config.debugDatabase) return DONE;
	return db.deleteConversation(conversation.id);
}

/**
 *
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export function appendBillingLog(log) {
	if (log.message_id == null) return DONE;
	return db.appendBillingLog(log);
}

export function getBillingLog(message_id) {
	if (message_id == null) return DONE;
	return db.getBillingLog(message_id);
}