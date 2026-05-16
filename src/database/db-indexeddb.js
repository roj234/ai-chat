import {getTextContent} from "../utils/utils.js";
import {DONE} from "../database.js";


const DB_NAME = 'AiChat';
const DB_VERSION = 8;

/** @type {Promise<IDBDatabase>} */
let dbPromise;

export const deleteDatabase = async () => {
	return (dbPromise||DONE).then(db => {
		if (db) db.close();
		const req = indexedDB.deleteDatabase(DB_NAME);
		req.onblocked = () => {
			alert("请关闭其它页面");
		};

		return new Promise((resolve, reject) => {
			req.onsuccess = resolve;
			req.onerror = reject;
		});
	});
};

/**
 * 打开并返回数据库实例
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
	return dbPromise || (
		dbPromise = new Promise((resolve, reject) => {
			navigator.storage?.persist();

			const request = indexedDB.open(DB_NAME, DB_VERSION);

			request.onupgradeneeded = (event) => {
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
				} else {
					if (oldVersion === 7) {
						db.deleteObjectStore("statistics");
						db.createObjectStore('logs', { keyPath: 'id' });
					} else {
						alert("不支持的数据库版本，请手动更新");
						throw "error";
					}
				}
			};

			request.onsuccess = (event) => {
				const db = event.target.result;
				// 长期持有连接时建议监听 close
				db.onversionchange = () => {
					db.close();
					alert('Database version changed, please reload page.');
				};
				resolve(db);
			};

			request.onerror = (event) => {
				reject(new Error(`Database error: ${event.target.error?.message || event.target.error}`));
			};
		}));
}


let batchQueue;
let batchWrite;
let batchStore;

const runBatch = async () => {
	const queue = batchQueue;
	const stores = [...batchStore];
	const mode = batchWrite ? "readwrite": "readonly";
	batchQueue = batchStore = batchWrite = 0;

	const tx = (await openDb()).transaction(stores, mode);
	tx.onerror = () => {
		const error = new Error(tx.error?.message);
		for (const el of queue) el[2](error);
	};
	for (const [fn, resolve] of queue) {
		const v = fn(tx, resolve);
		if (v) v.onsuccess = (event) => resolve(event.target.result);
	}
};

/**
 *
 * @param {function(tx: IDBTransaction, resolve: (value: (PromiseLike<unknown> | unknown)) => void): void | IDBRequest<unknown>} callback
 * @param {boolean=} write
 * @param {string} database
 * @return {Promise<unknown>}
 */
const transaction = (callback, write, ...database) => new Promise((resolve, reject) => {
	const data = [ callback, resolve, reject ];
	if (!batchQueue) {
		batchQueue = [data];
		batchStore = new Set(database);
		setTimeout(runBatch);
	} else {
		batchQueue.push(data);
		database.forEach(item => batchStore.add(item));
	}
	batchWrite |= write;
});

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = conversation => transaction((tx, resolve) => {
	const request = tx.objectStore('messages').index('owner').getAll(conversation.id);
	request.onsuccess = (event) => {
		resolve(event.target.result.sort((a, b) => {
			const b1 = a.role === "system";
			const b2 = b.role === "system";
			if (b1 !== b2) return b2 - b1;
			return 0;
		}));
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
export const deleteMessage = id => transaction((tx) => tx.objectStore('messages').delete(id), true, 'messages');

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
 * @param {IDBValidKey} key
 * @returns {Promise<any>}
 */
export const getKV = key => transaction(tx => tx.objectStore('kv').get(key), false, 'kv');

/**
 * 创建、更新或删除KV存储
 * @param {IDBValidKey} key
 * @param {Object & Partial<AiChat.IDBKVList>} value
 * @returns {Promise<void>}
 */
export const setKV = (key, value) => transaction(tx => {
	const store = tx.objectStore('kv');
	return value === undefined ? store.delete(key) : store.put(value, key);
}, true, 'kv');

/**
 * 读取KV存储列表
 * @param {IDBValidKey} type
 * @returns {Promise<(Object & AiChat.IDBKVList)[]>}
 */
export const kvListGetValues = type => transaction(tx => tx.objectStore('kvs').getAll(type === '*' ? null : IDBKeyRange.bound([type], [type, '\uffff'])), false, 'kvs');

/**
 * 读取KV存储列表的key
 * @param {IDBValidKey} type
 * @returns {Promise<AiChat.IDBKVList[]>}
 */
export const kvListGetKeys = type => transaction((tx, resolve) => {
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
			resolve(results);
		}
	};
}, false, 'kvs');

/**
 * 获取一项
 * @param {IDBValidKey} type
 * @param {IDBValidKey} name
 * @returns {Promise<Object & AiChat.IDBKVList>}
 */
export const kvListGet = (type, name) => transaction(tx => tx.objectStore('kvs').get([type, name]), false, 'kvs');


/**
 * 创建、更新或删除KV存储
 * @param {Object & AiChat.IDBKVList} value
 * @param {IDBValidKey=} type
 * @param {IDBValidKey=} name
 * @returns {Promise<number>}
 */
export const kvListSet = (value, type, name) => {
	if (type) value.type = type;
	if (name) value.name = name;
	return transaction(tx => tx.objectStore('kvs').put(value), true, 'kvs');
};

/**
 * 删除KV存储列表
 * @param {string} type
 * @param {string} name
 * @returns {Promise<void>}
 */
export const kvListDel = (type, name) => transaction(tx => tx.objectStore('kvs').delete([type, name]), true, 'kvs');

/**
 *
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export const appendBillingLog = log => transaction(tx => tx.objectStore('logs').add(log), true, 'logs');

export const getBillingLog = id => transaction(tx => tx.objectStore('logs').get(id), false, 'logs');
