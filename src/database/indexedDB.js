import {getTextContent} from "../utils/utils.js";
import {IndexedDBAccess} from "../utils/dbAccess.js";
import {EVENT_BUS} from "../states.js";
import {debugSymbol} from "@roj234/shared";
import {rep} from "unconscious/common/deepEqual.js";
import {ALLOW_META} from "/backend/sync.js";

const [transaction, deleteDatabase] = IndexedDBAccess('AiChat', 11, (event) => {
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
		db.createObjectStore("kvsMeta", { keyPath: ['type', 'name'] });

		// 计费日志：id 为消息 id；time 索引用于日志页按时间范围分页
		db.createObjectStore('logs', { keyPath: 'id' }).createIndex('time', 'time');
		return;
	}

	if (oldVersion < 9) { alert("数据库版本太老，请先用旧版更新到 V9！"); throw "error"; }
	if (oldVersion < 10) tx.objectStore('logs').createIndex('time', 'time');
	if (oldVersion < 11) {
		const metaStore = db.createObjectStore("kvsMeta", { keyPath: ['type', 'name'] });

		tx.objectStore('kvs').openCursor().onsuccess = ({target}) => {
			const cursor = target.result;
			if (!cursor) return;

			const {type, name, meta} = cursor.value;
			if (ALLOW_META.has(type)) metaStore.put({type, name, meta});

			cursor.continue();
		};
	}
});

export {deleteDatabase};

export const initialize = () => {
	return new Promise((resolve, reject) => {
		navigator.locks.request(APP_NAME+':singleton', { ifAvailable: true }, lock => {
			if (!lock) {
				reject("因为作者很菜写不好分布式锁。\n所以 indexedDB 数据库必须单例，\n请关闭其它Aint标签页");
				return;
			}

			resolve();
			return new Promise(() => {}); // 永久持有，页面卸载时自动释放
		});
	})
}

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = conversation => transaction((tx, resolve) => {
	const request = tx.objectStore('messages').index('owner').getAll(conversation.id);
	request.onsuccess = (event) => resolve(event.target.result);
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
 * @returns {Promise<any>}
 */
export const getKV = (key) => transaction(tx => tx.objectStore('kv').get(key), false, 'kv');

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
export const kvListGetValues = type => transaction(tx => tx.objectStore('kvs')
	.getAll(type === '*' ? null : IDBKeyRange.bound([type], [type, '\uffff'])), false, 'kvs');

/**
 * @param {string} type
 * @returns {Promise<AiChat.IDBKVList[]>}
 */
export const kvListGetKeys = (type) => ALLOW_META.has(type)
	? transaction(tx => tx.objectStore('kvsMeta')
		.getAll(IDBKeyRange.bound([type], [type, '\uffff'])), false, 'kvsMeta')
		.then(rows => {
			rows.forEach(s => {delete s.type});
			return rows;
		})
	: transaction((tx, resolve) => {
		const results = [];

		tx.objectStore('kvs').openKeyCursor(IDBKeyRange.bound([type], [type, '\uffff'])).onsuccess = (event) => {
			const cursor = event.target.result;
			if (cursor) {
				const [_, name] = cursor.key;
				results.push({name});
				cursor.continue();
			} else {
				resolve(results);
			}
		};
	}, false, 'kvs');

const DB_NAME = debugSymbol("Name");

/**
 * @param {string} type
 * @param {string} name
 * @returns {Promise<Object & AiChat.IDBKVList>}
 */
export const kvListGet = (type, name) => transaction(tx => tx.objectStore('kvs').get([type, name]), false, 'kvs').then(item => {
	item[DB_NAME] = item.name;
	return item;
});

/**
 * @param {Object & AiChat.IDBKVList} value
 * @param {string=} type
 * @param {string=} [name]
 * @returns {Promise<void>}
 */
export const kvListSet = (value, type, name) => {
	value.type = type;

	if (name) value.name = name;
	else name = value.name;

	const oldName = value[DB_NAME];
	value[DB_NAME] = name;

	const meta = value.meta;

	const allowMeta = ALLOW_META.has(type);
	if (meta) {
		if (!allowMeta) return Promise.reject('对象 '+type+' 不支持 "meta"');
		//if (encodeMsg(meta).length > 255) throwDOMException('"meta" 大于 255 字节');
	}

	return transaction(tx => {
		const kvsStore = tx.objectStore('kvs');
		const kvsMetaStore = tx.objectStore('kvsMeta');
		if (oldName !== undefined && oldName !== name) {
			const key = [type, oldName];
			if (allowMeta) kvsMetaStore.delete(key);
			kvsStore.delete(key);
			EVENT_BUS.post(['kvs', type, 'del'], name);
		}
		if (allowMeta) kvsMetaStore.put({type, name, meta});
		return kvsStore.put(value);
	}, true, 'kvs', 'kvsMeta').then(() => EVENT_BUS.post(['kvs', type, 'set'], name, rep(meta)));
};

/**
 * @param {string} type
 * @param {string} name
 * @returns {Promise<void>}
 */
export const kvListDel = (type, name) => transaction(tx => {
	const key = [type, name];
	if (ALLOW_META.has(type)) tx.objectStore('kvsMeta').delete(key);
	return tx.objectStore('kvs').delete(key);
}, true, 'kvs', 'kvsMeta');

/**
 * @param {AiChat.BillingLog} log
 * @return {Promise<void>}
 */
export const appendBillingLog = log => {
	if (log.id <= 0) return Promise.resolve();

	log.time ||= Date.now();

	return transaction((tx, resolve) => {
		const store = tx.objectStore('logs');
		const count = store.count();

		count.onsuccess = ((e) => {
			if (e.target.result < 15000) return;
			let remaining = 5000;

			const cursor = store.index('time').openCursor();
			cursor.onsuccess = ({target}) => {
				const current = target.result;
				if (!current || --remaining <= 0) return;

				current.delete();
				current.continue();
			};
		});

		return store.put(log);
	}, true, 'logs');
};

/**
 * @param {number} messageId
 * @returns {Promise<AiChat.BillingLog>}
 */
export const getBillingLog = messageId => transaction(tx => tx.objectStore('logs').get(messageId), false, 'logs');

/**
 * @param {number=} startTime
 * @param {number=} endTime
 * @returns {Promise<AiChat.BillingLog[]>}
 */
export const listBillingLogs = (startTime = 0, endTime = Date.now()) =>
	transaction((tx, resolve) => {
		const rows = [];
		const request = tx.objectStore('logs')
			.index('time')
			.openCursor(IDBKeyRange.bound(startTime, endTime), 'prev');

		request.onsuccess = ({target}) => {
			const cursor = target.result;
			if (!cursor) { resolve(rows); return; }

			rows.push(cursor.value);
			cursor.continue();
		};
	}, false, 'logs');