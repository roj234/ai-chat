import {debugSymbol, unconscious} from 'unconscious';
import {BRANCH_MANAGER, config, conversations, EVENT_BUS, LOCKED} from "./states.js";
import {deepEqual, delta} from "unconscious/common/deepEqual.js";
import {prettyError} from "./utils/utils.js";
import * as idb from "./database/indexedDB.js";
import * as remote from "./database/remoteDB.js";
import {showToast} from "./components/Toast.js";
import {enableBranches} from "./utils/BranchManager.js";

export const MESSAGES_SNAPSHOT = debugSymbol("MessagesSnapshot");
export const DIFF_SNAPSHOT = debugSymbol("DiffSnapshot");
export const PENDING_UPDATE = debugSymbol("PendingUpdate");
export const MESSAGES_CACHE = debugSymbol("Messages");
const MESSAGE_IS_CLEAN = debugSymbol("Clean");

export const DONE = Promise.resolve();

export const databaseError = err => {
	showToast("数据库错误!\n"+prettyError(err)+"\n建议导出(备份)当前对话", 'error');
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
	 * 获取KV列表中的一项
	 * @param {string} type
	 * @param {string} name
	 * @returns {Promise<Object & AiChat.IDBKVList>}
	 */
	kvListGet,
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

	/**
	 * 创建或更新KV列表的项目
	 * 由于事件派发顺序问题，必须把代码写在数据库驱动里面
	 * @param {Object & AiChat.IDBKVList} value
	 * @param {string=} type
	 * @param {string=} name
	 * @returns {Promise<void>}
	 */
	kvListSet,

	uploadBlob,
	getBlob,

	getBillingLog,
	listBillingLogs,
	/**
	 * @param {AiChat.BillingLog} log
	 * @return {Promise<void>}
	 */
	appendBillingLog
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

const fetchMessagesFromDB = throttledPromise(db.getMessages);

/**
 * 获取一个会话的消息，缓存优先
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = async (conversation) => {
	const bm = conversation[BRANCH_MANAGER];
	if (bm) return bm.getMessages();
	return (conversation[MESSAGES_CACHE] || fetchMessages(conversation));
};

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const fetchMessages = throttledPromise(async conversation => {
	let messages = await fetchMessagesFromDB(conversation);
	conversation[DIFF_SNAPSHOT] = structuredClone(conversation);

	const isBranchConversation = conversation.bm_leaf != null;

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

		delete conversation[BRANCH_MANAGER];
		if (isBranchConversation) {
			messages = enableBranches(conversation, messages);
		}

		await EVENT_BUS.post(['conversationLoad'], conversation, messages);
	} else {
		if (isBranchConversation) return enableBranches(conversation, messages);
	}

	return messages;
});

const DIFF_IGNORE_KEYS = new Set(["id", "ready"]);

/**
 * 更新会话
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]|false=} messages
 * @param {boolean=} keepTime
 * @returns {Promise<void>}
 */
export const updateConversation = async (conversation, messages, keepTime) => {
	if (conversation.temporary) {
		if (undefined === conversation[MESSAGES_CACHE]) conversation[MESSAGES_CACHE] = messages;
		return;
	}
	if (conversation[LOCKED]) return;

	// 串行化
	let promise = conversation[PENDING_UPDATE] || DONE;
	promise = promise.then(() => updateConversation_(conversation, unconscious(messages), keepTime), databaseError);
	promise.finally(() => {
		if (conversation[PENDING_UPDATE] === promise)
			delete conversation[PENDING_UPDATE];
	});
	return promise;
};
/**
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]|false=} messages
 * @param {boolean=} keepTime
 * @returns {Promise<*>}
 */
const updateConversation_ = async (conversation, messages, keepTime) => {
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
			conversations.unshift(conversation);
		});
		if (isIDB) await promise;
		// 后端事务会自动提取新增的id，前端不需要处理
	} else if (null == conversation[DIFF_SNAPSHOT]) {
		if (isIDB) conversation[DIFF_SNAPSHOT] = structuredClone(conversation);
		else {
			const data = conversation[DIFF_SNAPSHOT] = await db.getConversation(conversation);

			const copy = {...data};
			delete copy.name;
			delete copy.meta;

			Object.assign(conversation, copy);
		}
	}

	if (messages) {
		if (conversation[BRANCH_MANAGER]) messages = conversation[BRANCH_MANAGER].raw;

		if (import.meta.env.DEV) {
			if (messages !== conversation[MESSAGES_CACHE] && undefined !== conversation[MESSAGES_CACHE]) {
				showToast("传入的消息数组不正确", "error");
				console.trace(messages, conversation[MESSAGES_CACHE]);
			}
		}

		if (undefined === conversation[MESSAGES_CACHE]) conversation[MESSAGES_CACHE] = messages;
		//else conversation[MESSAGES_CACHE] = messages;

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
				} else {
					if (import.meta.env.DEV) {
						const diff = delta(snapshot, message, DIFF_IGNORE_KEYS);
						if (undefined !== diff) {
							showToast("database diff error\nmissing markDirty call", "error");
							console.error(snapshot, structuredClone(message), diff);
						}
					}
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

			// 后面会写 owner 字段，浅拷贝
			if (typeof diff !== 'object') diff = {...snapshot};

			if (message.id > 0) diff.id = message.id;
			else delete diff.id;
			diff.owner = conversation.id;

			// 必须先设置再回滚，因为这是异步的，如果请求过程中有修改，后续会再调用一次updateConversation
			message[MESSAGE_IS_CLEAN] = true;

			promises.push(db.upsertMessage(diff).then((id) => {
				message.id = snapshot.id = id;
				conversation[MESSAGES_SNAPSHOT].set(id, snapshot);
			}, (err) => {
				// 回滚
				delete message[MESSAGE_IS_CLEAN];
				if (message.id === -2) delete message.id;

				throw err;
			}));
		}

		if (messagesInDB.size) {
			if (!keepTime) conversation.time = Date.now();
			messagesInDB.forEach((value, id) => promises.push(db.deleteMessage(id/*, conversation*/)));
		}

		conversation[MESSAGES_SNAPSHOT] = messagesInMemory;
	}

	let convDiff;
	if (changed && (convDiff = isIDB ? (!deepEqual(conversation[DIFF_SNAPSHOT], conversation, DIFF_IGNORE_KEYS) && conversation) : delta(conversation[DIFF_SNAPSHOT], conversation, DIFF_IGNORE_KEYS))) {
		convDiff.id = conversation.id;
		changed(convDiff);
	}

	return Promise.all(promises);
};

/**
 * 删除会话及其所有消息
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<void>}
 */
export const deleteConversation = conversation => {
	if (conversation.temporary) return DONE;
	conversation[LOCKED] = "DELETED"; // 忽略后续的数据库写入
	const id = conversation.id;
	return db.deleteConversation(id).then(() => EVENT_BUS.post(['conversationDeleted', id], conversation));
};

/**
 * 创建、更新或删除KV存储
 * @param {string} key
 * @param {Object & Partial<AiChat.IDBKVList>} value
 * @returns {Promise<void>}
 */
export const setKV = (key, value) => db.setKV(key, value).then(() => EVENT_BUS.post(['kv', key], value));
/**
 * 删除KV列表一项
 * @param {string} type
 * @param {string} name
 * @returns {Promise<void>}
 */
export const kvListDel = (type, name) => db.kvListDel(type, name).then(() => EVENT_BUS.post(['kvs', type, 'del'], name));