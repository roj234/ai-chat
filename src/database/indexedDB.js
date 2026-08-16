import {getTextContent} from "../utils/utils.js";
import {sortMessages} from "/backend/sync.js";
import {IndexedDBAccess} from "../utils/dbAccess.js";

const [transaction, deleteDatabase] = IndexedDBAccess('AiChat', 9, (event) => {
	const db = event.target.result;
	const tx = event.target.transaction;

	const oldVersion = event.oldVersion;
	if (oldVersion === 0) {
		const newConvStore = db.createObjectStore('conversations', { keyPath: 'id', autoIncrement: true });
		newConvStore.createIndex('time', 'time');

		const newMsgStore = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
		newMsgStore.createIndex('owner', 'owner');

		db.createObjectStore('kv');
		db.createObjectStore("kvs", { keyPath: ['type', 'name'] });

		// 计费日志, 插入顺序就是时间顺序
		db.createObjectStore('logs', { keyPath: 'id' });
	} else if (oldVersion === 8) {
		const request = tx.objectStore('logs').openCursor();
		request.onsuccess = (e) => {
			const cursor = e.target.result;
			if (cursor) {
				const record = cursor.value;
				if (typeof record.cost === 'number') {
					record.cost = Math.round(record.cost * 1000000);
					cursor.update(record);
				}
				cursor.continue();
			}
		};
	} else {
		alert("不支持的数据库版本，请手动更新");
		throw "error";
	}
});

export {deleteDatabase};

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = conversation => transaction((tx, resolve) => {
	const request = tx.objectStore('messages').index('owner').getAll(conversation.id);
	request.onsuccess = (event) => {
		resolve(sortMessages(event.target.result));
	}
}, false, 'messages');

/**
 * 更新会话
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<number>}
 */
export const upsertConversation = conversation => transaction((tx) => tx.objectStore('conversations').put(conversation), true, 'conversations');

/**
 * 插入或更新消息
 * @param {AiChat.Message} message=
 * @returns {Promise<number>}
 */
export const upsertMessage = message => transaction((tx) => tx.objectStore('messages').put(message), true, 'messages');

/**
 * 按ID删除消息
 * @param {number} id
 * @returns {Promise<void>}
 */
export const deleteMessage = (id) => transaction((tx) => tx.objectStore('messages').delete(id), true, 'messages');

/**
 * 删除会话及其所有消息
 * @param {number} id
 * @returns {Promise<void>}
 */
export const deleteConversation = id => transaction(tx => {
	tx.objectStore('conversations').delete(id);

	const msgStore = tx.objectStore('messages');
	const cursorRequest = msgStore.index('owner').openKeyCursor(id);
	cursorRequest.onsuccess = (event) => {
		const cursor = event.target.result;
		if (cursor) {
			msgStore.delete(cursor.primaryKey);
			cursor.continue();
		}
	};
}, true, 'conversations', 'messages');

/**
 * 列出所有会话，按创建时间降序
 * @returns {Promise<Array<{id:number, title:string, time:number, messageId?:number}>>}
 */
export const listConversations = () => transaction((tx, resolve) => {
	const idx = tx.objectStore('conversations').index('time');

	const result = [];
	idx.openCursor(null, 'prev').onsuccess = (event) => {
		const cursor = event.target.result;
		if (cursor) {
			result.push(cursor.value);
			cursor.continue();
		} else {
			resolve(result);
		}
	};
}, false, 'conversations');

/**
 * 搜索所有消息中包含 keyword 的会话（全量扫描）
 * @param {string} keyword 搜索关键词（不区分大小写）
 * @returns {Promise<Array<AiChat.Conversation & {matchingMessages: AiChat.Message[]}>>}
 */
export const searchMessages = keyword => {
	const lowerKeyword = keyword.toLowerCase();

	return listConversations().then(conversations => {
		const promises = conversations.map(conv =>
			getMessages(conv).then(messages => {
				if (!messages) return null;

				messages = messages.filter(msg => getTextContent(msg)?.toLowerCase().includes(lowerKeyword));

				if (messages.length > 0) {
					messages.forEach(m => {
						delete m.tool_calls;
						delete m.tool_responses;
						delete m.owner;
					});

					return {
						...conv,
						messages
					};
				}
				return null;
			})
		);

		return Promise.all(promises).then(results => results.filter(Boolean));
	}).catch(err => {
		console.error('搜索失败:', err);
		return [];
	});
};

/**
 * 读取KV存储
 * @param {string} key
 * @param {import("unconscious").Reactive<any>=} callback
 * @returns {Promise<any>}
 */
export const getKV = (key, callback) => {
	let promise = transaction(tx => tx.objectStore('kv').get(key), false, 'kv');
	if (callback) promise.then(v => {
		if (v != null) callback.value = v;
	});
	return promise;
}

/**
 * 创建、更新或删除KV存储
 * @param {string} key
 * @param {Object & Partial<AiChat.IDBKVList>} value
 * @returns {Promise<void>}
 */
export const setKV = (key, value) => transaction(tx => {
	const store = tx.objectStore('kv');
	return value === undefined ? store.delete(key) : store.put(value, key);
}, true, 'kv');

/**
 * @param {string} type
 * @returns {Promise<(Object & AiChat.IDBKVList)[]>}
 */
export const kvListGetValues = type => transaction(tx => tx.objectStore('kvs').getAll(type === '*' ? null : IDBKeyRange.bound([type], [type, '\uffff'])), false, 'kvs');

/**
 * @param {string} type
 * @param {import("unconscious").Reactive<AiChat.IDBKVList[]>=} callback
 * @returns {Promise<AiChat.IDBKVList[]>}
 */
export const kvListGetKeys = (type, callback) => transaction((tx, resolve) => {
	const results = [];

	tx.objectStore('kvs').openCursor(IDBKeyRange.bound([type], [type, '\uffff'])).onsuccess = (event) => {
		const cursor = event.target.result;
		if (cursor) {
			const [type, name] = cursor.key;
			results.push({
				//type,
				name
			});
			cursor.continue();
		} else {
			if (callback) callback.value = results;
			resolve(results);
		}
	};
}, false, 'kvs');

/**
 * @param {string} type
 * @param {string} name
 * @returns {Promise<Object & AiChat.IDBKVList>}
 */
export const kvListGet = (type, name) => transaction(tx => tx.objectStore('kvs').get([type, name]), false, 'kvs');


/**
 * @param {Object & AiChat.IDBKVList} value
 * @param {string=} type
 * @param {string=} name
 * @returns {Promise<number>}
 */
export const kvListSet = (value, type, name) => {
	if (type) value.type = type;
	if (name) value.name = name;
	return transaction(tx => tx.objectStore('kvs').put(value), true, 'kvs');
};

/**
 * @param {string} type
 * @param {string} name
 * @returns {Promise<void>}
 */
export const kvListDel = (type, name) => transaction(tx => tx.objectStore('kvs').delete([type, name]), true, 'kvs');

/**
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export const appendBillingLog = log => transaction(tx => tx.objectStore('logs').add(log), true, 'logs');
/**
 * @param {number} messageId
 * @returns {Promise<AiChat.BillingLog>}
 */
export const getBillingLog = messageId => transaction(tx => tx.objectStore('logs').get(messageId), false, 'logs');

export const listBillingLogs = (startTime, endTime) => {
	throw new Error("Not implemented");
}