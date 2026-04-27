import {debugSymbol} from 'unconscious';
import {config} from "./states.js";
import {isEqual} from "../vendor/equals.js";
import {cloneNamed} from "./utils/utils.js";
import * as db from "./database-idb.js";

const MESSAGE_IN_DB = debugSymbol("MESSAGE_IN_DB");
const CONVERSATION_IN_DB = debugSymbol("CONVERSATION_IN_DB");
export const DONE = Promise.resolve();

export {
	deleteDatabase,
	getKV, setKV,
	kvListGetValues, kvListSet, kvListDel, kvListGetKeys, kvListGet, kvListGetByName,
	listConversations, searchMessages
} from "./database-idb.js";

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export function getMessages(conversation) {
	return db.getMessages(conversation).then(messages => {
		/**
		 * @type {Map<number, string>}
		 */
		const m = new Map();
		conversation[MESSAGE_IN_DB] = m;
		conversation[CONVERSATION_IN_DB] = serializeConversation(conversation);

		for (let message of messages) {
			delete message.owner;
			m.set(message.id, structuredClone(message));
		}

		return messages;
	});
}

/**
 * 新建一个会话
 * @returns {Promise<AiChat.Conversation>}
 */
export function newConversation() {
	const conversation = {
		title: "",
		time: Date.now(),
		[MESSAGE_IN_DB]: new Map
	};

	if (config.debugDatabase) {
		conversation.id = -1;
		return Promise.resolve(conversation);
	}

	return db.newConversation(conversation);
}

const IGNORE_ID = new Set(["id"]);

export const CONVERSATION_KEYS = ["id", "title", "time", "allowedTools", "activatedModules"];

function serializeConversation(data) {
	return cloneNamed(data, CONVERSATION_KEYS);
}

/**
 * 更新会话
 * @param {AiChat.Conversation} data
 * @param {AiChat.Message[]|false} messages=
 * @returns {Promise<void>}
 */
export function updateConversation(data, messages) {
	if (config.debugDatabase) return DONE;
	if (isNaN(data.time)) data.time = Date.now();

	const promises = [];

	const serializedForm = serializeConversation(data);
	if (!isEqual(data[CONVERSATION_IN_DB], serializedForm, IGNORE_ID)) {
		data[CONVERSATION_IN_DB] = serializedForm;
		promises.push(db.updateConversation(serializedForm));
	}

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

	return Promise.all(promises);
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