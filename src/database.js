import {debugSymbol, unconscious} from 'unconscious';
import {BRANCH_MANAGER, config, CONFIG_VERSION, LOCKED} from "./states.js";
import {deepEqual, delta} from "unconscious/common/deepEqual.js";
import {prettyError} from "./utils/utils.js";
import * as idb from "./database/indexedDB.js";
import * as remote from "./database/remoteDB.js";
import {showToast} from "./components/Toast.js";

export const MESSAGES_SNAPSHOT = debugSymbol("MessagesSnapshot");
export const DIFF_SNAPSHOT = debugSymbol("DiffSnapshot");
export const PENDING_UPDATE = debugSymbol("PendingUpdate");
export const MESSAGES_CACHE = debugSymbol("Messages");
const MESSAGE_IS_CLEAN = debugSymbol("Clean");

export const DONE = Promise.resolve();

export const databaseError = err => {
	showToast("数据库错误!\n"+prettyError(err)+"\n更改可能丢失，建议从设置导出当前对话", 'error', 0);
};

export const isIDB = DB_MODE === 'local' || config.db_server === ':idb:';

const db = isIDB ? idb : remote;

export const {
	initialize,
	deleteDatabase,

	/**
	 * 列出所有会话，按创建时间降序
	 * @param {number=} lastTimestamp 304 时间戳
	 * @returns {Promise<Array<{id:number, title:string, time:number}>>}
	 */
	listConversations,
	searchMessages,

	/**
	 * 读取KV存储
	 * @param {string} key
	 * @param {import("unconscious").Reactive<any>=} callback
	 * @returns {Promise<any>}
	 */
	getKV,
	/**
	 * 创建、更新或删除KV存储
	 * @param {string} key
	 * @param {Object & Partial<AiChat.IDBKVList>} value
	 * @returns {Promise<void>}
	 */
	setKV,

	/**
	 * 获取KV列表中的一项
	 * @param {string} type
	 * @param {string} name
	 * @returns {Promise<Object & AiChat.IDBKVList>}
	 */
	kvListGet,
	/**
	 * 创建或更新KV列表的项目
	 * @param {Object & AiChat.IDBKVList} value
	 * @param {string=} type
	 * @param {string=} name
	 * @returns {Promise<number>}
	 */
	kvListSet,
	/**
	 * 删除KV列表一项
	 * @param {string} type
	 * @param {string} name
	 * @returns {Promise<void>}
	 */
	kvListDel,
	/**
	 * 读取KV列表的keys
	 * @param {string} type
	 * @param {import("unconscious").Reactive<AiChat.IDBKVList[]>=} callback
	 * @returns {Promise<AiChat.IDBKVList[]>}
	 */
	kvListGetKeys,
	/**
	 * 读取KV列表的所有项
	 * @param {string | '*'} type
	 * @returns {Promise<(Object & AiChat.IDBKVList)[]>}
	 */
	kvListGetValues,

	uploadBlob,
	getBlob,

	getBillingLog,
	listBillingLogs
} = db;

/**
 * @param {AiChat.Message} message
 */
export const markMessageDirty = (message) => {
	delete message[MESSAGE_IS_CLEAN];
};

/**
 * 清除对话的脏标记
 * @param {AiChat.Conversation} conversation 对话
 * @param {number} id
 * @param {AiChat.Message} message
 */
export const clearMessageDirty = (conversation, id, message) => {
	/** @type {Map<number, AiChat.Message>} */
	const m = conversation[MESSAGES_SNAPSHOT];
	if (message) m.set(id, structuredClone(message));
	else m.delete(id);
}

/**
 * @template {Function} T
 * @param {T} fn
 * @return {T}
 */
const throttledPromise = (fn) => {
	const map = new Map();
	return (arg0) => {
		let promise = map.get(arg0);
		if (!promise) {
			promise = fn(arg0);
			map.set(arg0, promise);
			promise.finally(() => map.delete(arg0));
		}
		return promise;
	}
};

const getMessages_ = throttledPromise(db.getMessages);

/**
 * 获取一个会话的消息，缓存优先
 * @param {AiChat.Conversation} conversation 对话
 * @param {boolean} [noStore] 结果不保存到缓存
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessagesCacheFirst = async (conversation, noStore) => (conversation[MESSAGES_CACHE] || (noStore ? getMessages_(conversation) : getMessages(conversation)));

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = throttledPromise(conversation => (
	getMessages_(conversation).then(messages => {
		conversation[DIFF_SNAPSHOT] = structuredClone(conversation);

		if (messages !== conversation[MESSAGES_CACHE]) {
			/** @type {Map<number, AiChat.Message>} */
			const m = new Map();

			conversation[MESSAGES_SNAPSHOT] = m;
			conversation[MESSAGES_CACHE] = messages;

			for (let message of messages) {
				delete message.owner;
				m.set(message.id, structuredClone(message));
				message[MESSAGE_IS_CLEAN] = true;
			}
		}

		return messages;
	})
));

const DIFF_IGNORE_KEYS = new Set(["id", "ready"]);

/**
 * 更新会话
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]|false=} messages
 * @param {boolean=} keepTime
 * @returns {Promise<void>}
 */
export const updateConversation = async (conversation, messages, keepTime) => {
	if (config.incognito || conversation[LOCKED]) return;

	const prevUpdate = conversation[PENDING_UPDATE];
	if (prevUpdate) await prevUpdate;

	let promises = [];
	let changed = (diff) => {
		changed = null;
		conversation[DIFF_SNAPSHOT] = structuredClone(conversation);
		const updateAndThen = db.upsertConversation(diff);
		promises.push(updateAndThen);
		return updateAndThen;
	};

	// 新对话
	if (!("id" in conversation)) {
		conversation[MESSAGES_SNAPSHOT] = new Map;
		const {ready, ...rest} = conversation;
		conversation.id = null;
		const promise = changed(rest).then(id => {
			conversation.id = id;
		});
		if (isIDB) await promise;
		// 后端事务会自动提取新增的id，前端不需要处理
	}

	if (messages) {
		if (conversation[BRANCH_MANAGER]) messages = conversation[BRANCH_MANAGER].messages;

		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInDB = conversation[MESSAGES_SNAPSHOT];
		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInMemory = new Map();

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			const id = message.id;
			if (id < 0) continue;

			let diff;
			if (id) {
				const snapshot = messagesInDB.get(id);
				messagesInDB.delete(id);

				if (!message[MESSAGE_IS_CLEAN]) {
					diff = isIDB ? !deepEqual(snapshot, message, DIFF_IGNORE_KEYS) : delta(snapshot, message, DIFF_IGNORE_KEYS);
				}
				if (!diff) {
					message[MESSAGE_IS_CLEAN] = true;
					messagesInMemory.set(id, snapshot);
					continue;
				}
			} else {
				// 新消息防止重复入库
				message.id = -2;
			}

			if (!keepTime) conversation.time = Date.now();

			let snapshot = structuredClone(message);
			if (id) messagesInMemory.set(id, snapshot);

			// 后面会写 owner 字段，浅拷贝
			if (typeof diff !== 'object') diff = {...snapshot};

			function save() {
				if (message.id > 0) diff.id = message.id;
				else delete diff.id;
				diff.owner = conversation.id;

				const savedState = structuredClone(message);
				message[MESSAGE_IS_CLEAN] = true;

				return db.upsertMessage(diff).then((id) => {
					snapshot = savedState;
					message.id = snapshot.id = id;
					conversation[MESSAGES_SNAPSHOT].set(id, snapshot);

					// 消息在RTT内又修改了，重新更新
					if (!message[MESSAGE_IS_CLEAN]) {
						diff = delta(snapshot, message, DIFF_IGNORE_KEYS);
						if (diff) return save();
					}
				});
			}
			promises.push(save().finally(() => {
				// 如果新消息保存失败，不要阻止后续保存
				if (message.id === -2) delete message.id;
			}));
		}

		if (messagesInDB.size) {
			if (!keepTime) conversation.time = Date.now();
			messagesInDB.forEach((value, id) => promises.push(db.deleteMessage(id, conversation)));
		}

		conversation[MESSAGES_SNAPSHOT] = messagesInMemory;
	}

	let convDiff;
	if (changed && (convDiff = isIDB ? (!deepEqual(conversation[DIFF_SNAPSHOT], conversation, DIFF_IGNORE_KEYS) && conversation) : delta(conversation[DIFF_SNAPSHOT], conversation, DIFF_IGNORE_KEYS))) {
		convDiff.id = conversation.id;
		changed(convDiff);
	}

	const wait = Promise.all(promises).catch(databaseError);
	conversation[PENDING_UPDATE] = wait;
	await wait;
	delete conversation[PENDING_UPDATE];
};

/**
 * 删除会话及其所有消息
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<void>}
 */
export const deleteConversation = conversation => {
	if (config.incognito) return DONE;
	return db.deleteConversation(conversation.id);
};

/**
 *
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export const appendBillingLog = log => {
	if (config.incognito) return DONE;
	return db.appendBillingLog(log);
};

const MERGED_CONFIG = debugSymbol("MergedConfig");

/**
 *
 * @param {AiChat.Conversation} conv
 * @return {Promise<AiChat.LocalPreset>}
 */
export const getCombinedPreset = async (conv) => {
	const globalPreset = unconscious(config);
	const presets = conv.presets;
	const overrides = conv.overrides;
	if (!overrides && !presets) return globalPreset;

	let combined = conv[MERGED_CONFIG];
	if (!combined || combined[CONFIG_VERSION] !== globalPreset[CONFIG_VERSION]) {
		combined = conv[MERGED_CONFIG] = {...globalPreset};
		if (presets) {
			if (Array.isArray(presets)) {
				for (const preset of presets) {
					Object.assign(combined, await kvListGet('preset', preset));
				}
			} else {
				Object.assign(combined, await kvListGet('preset', presets));
			}
		}
		if (overrides) Object.assign(combined, overrides);
	}
	return combined;
}

export const markCombinedPresetDirty = (conv) => {
	delete conv[MERGED_CONFIG];
}