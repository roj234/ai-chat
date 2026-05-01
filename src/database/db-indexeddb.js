import {getTextContent} from "../utils/utils.js";
import {DONE} from "../database.js";
import {AS_IS} from "unconscious";


const DB_NAME = 'AiChat';
const DB_VERSION = 7;

let dbPromise;

export async function deleteDatabase() {
	let promise = dbPromise || DONE;

	return promise.then(db => {
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
}

/**
 * 打开并返回数据库实例（单例）
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

					// 替代 localStorage 放置 $store ?
					db.createObjectStore('kv');
					const kvs = db.createObjectStore("kvs", { keyPath: 'id', autoIncrement: true });
					kvs.createIndex('name', ['type', 'name']);

					// 计费日志, 插入顺序就是时间顺序
					db.createObjectStore('statistics', { keyPath: 'message_id' });
				} else {
					alert("不支持的数据库版本，请手动更新");
					throw "error";
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

/**
 *
 * @param {string | string[]} database
 * @param {function(tx: IDBTransaction, resolve: (value: (PromiseLike<unknown> | unknown)) => void): void | IDBRequest<unknown>} callback
 * @param {boolean=} write
 * @return {Promise<unknown>}
 */
function transaction(database, callback, write) {
	return new Promise(async (resolve, reject) => {
		const tx = (await openDb()).transaction(database, write ? 'readwrite' : 'readonly');
		tx.onerror = () => reject(new Error(tx.error?.message));
		tx.oncomplete = resolve;
		const v = callback(tx, resolve);
		if (v) v.onsuccess = (event) => resolve(event.target.result);
	});
}

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export function getMessages(conversation) {
	return transaction('messages', (tx, resolve) => {
		const store = tx.objectStore('messages');
		// 也可使用 IDBKeyRange.only()
		const request = store.index('owner').getAll(conversation.id);

		request.onsuccess = (event) => {
			const messages = event.target.result;

			messages.sort((a, b) => {
				const b1 = a.role === "system";
				const b2 = b.role === "system";
				if (b1 !== b2) return b2 - b1;

				return a.time - b.time
			});

			resolve(messages);
		}
	});
}

/**
 * 新建一个会话
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<AiChat.Conversation>}
 */
export function newConversation(conversation) {
	return transaction('conversations', (tx, resolve) => {
		const req = tx.objectStore('conversations').add(conversation);
		req.onsuccess = (e) => {
			conversation.id = e.target.result;
			resolve(conversation);
		};
	}, true);
}

/**
 * 更新会话
 * @param {AiChat.Conversation} conversation
 * @returns {Promise<void>}
 */
export function updateConversation(conversation) {
	return transaction('conversations', tx => {
		return tx.objectStore('conversations').put(conversation);
	}, true);
}

/**
 * 插入或更新消息
 * @param {AiChat.Message} message=
 * @returns {Promise<void>}
 */
export function updateMessage(message) {
	return transaction('messages', (tx, resolve) => {
		const messageStore = tx.objectStore('messages');
		messageStore.put(message).onsuccess = (e) => {
			message.id = e.target.result;
			resolve(message);
		}
	}, true);
}

/**
 * 按ID删除消息
 * @param {number} id
 * @returns {Promise<void>}
 */
export function deleteMessage(id) {
	return transaction('messages', (tx) => tx.objectStore('messages').delete(id), true);
}

/**
 * 删除会话及其所有消息
 * @param {number} id
 * @returns {Promise<void>}
 */
export function deleteConversation(id) {
	return transaction(['conversations', 'messages'], tx => {
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
	}, true);
}

/**
 * 列出所有会话，按创建时间降序
 * @returns {Promise<Array<{id:number, title:string, time:number, messageId?:number}>>}
 */
export function listConversations() {
	return transaction('conversations', (tx, resolve) => {
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
	});
}

/**
 * 搜索所有消息中包含 keyword 的会话（全量扫描）
 * @param {string} keyword 搜索关键词（不区分大小写）
 * @returns {Promise<Array<AiChat.Conversation & {matchingMessages: AiChat.Message[]}>>}
 */
export function searchMessages(keyword) {
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
}

/**
 * 读取KV存储
 * @param {IDBValidKey} key
 * @returns {Promise<any>}
 */
export function getKV(key) {
	return transaction('kv', tx => tx.objectStore('kv').get(key));
}

/**
 * 创建、更新或删除KV存储
 * @param {IDBValidKey} key
 * @param {Object & Partial<AiChat.IDBKVList>} value
 * @returns {Promise<void>}
 */
export function setKV(key, value) {
	return transaction('kv', tx => {
		const store = tx.objectStore('kv');
		return value === undefined ? store.delete(key) : store.put(value, key);
	}, true);
}

/**
 * 读取KV存储列表
 * @param {IDBValidKey} type
 * @returns {Promise<(Object & AiChat.IDBKVList)[]>}
 */
export function kvListGetValues(type) {
	return transaction('kvs', tx => tx.objectStore('kvs').index('name').getAll(IDBKeyRange.bound([type], [type, '\uffff'])));
}

/**
 * 读取KV存储列表的key
 * @param {IDBValidKey} type
 * @returns {Promise<AiChat.IDBKVList[]>}
 */
export function kvListGetKeys(type) {
	return transaction('kvs', (tx, resolve) => {
		const results = [];

		tx.objectStore('kvs').index('name').openCursor(IDBKeyRange.bound([type], [type, '\uffff'])).onsuccess = (event) => {
			const cursor = event.target.result;
			if (cursor) {
				const [type, name] = cursor.key;
				results.push({
					id: cursor.primaryKey,
					//type,
					name
				});
				cursor.continue();
			} else {
				resolve(results);
			}
		};
	});
}

/**
 * 获取一项
 * @param {number} key
 * @returns {Promise<Object & AiChat.IDBKVList>}
 */
export function kvListGet(key) {
	return transaction('kvs', tx => tx.objectStore('kvs').get(key));
}

/**
 * 获取一项
 * @param {IDBValidKey} type
 * @param {IDBValidKey} name
 * @returns {Promise<Object & AiChat.IDBKVList>}
 */
export function kvListGetByName(type, name) {
	return transaction('kvs', tx => tx.objectStore('kvs').index("name").get([type, name]));
}


/**
 * 创建、更新或删除KV存储
 * @param {Object & AiChat.IDBKVList} value
 * @param {IDBValidKey=} type
 * @param {IDBValidKey=} name
 * @returns {Promise<number>}
 */
export function kvListSet(value, type, name) {
	if (type) value.type = type;
	if (name) value.name = name;
	return transaction('kvs', tx => tx.objectStore('kvs').put(value), true);
}

/**
 * 删除KV存储列表
 * @param {number} key
 * @returns {Promise<void>}
 */
export function kvListDel(key) {
	return transaction('kvs', tx => tx.objectStore('kvs').delete(key), true);
}

/**
 *
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export function appendBillingLog(log) {
	return transaction('statistics', tx => tx.objectStore('statistics').add(log), true);
}

export function getBillingLog(message_id) {
	return transaction('statistics', tx => tx.objectStore('statistics').get(message_id));
}
