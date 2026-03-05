import {mergeReasoningDetails} from "./ThinkBlock.jsx";
import {debugSymbol} from 'unconscious';

const DB_NAME = 'AiChat';
const DB_VERSION = 2;

let dbPromise;

const CURRENT_IN_IDB = debugSymbol("Current_In_IDB");

export async function deleteDatabase() {
	let promise = dbPromise;
	if (!promise) promise = Promise.resolve();

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
	if (dbPromise) return dbPromise;

	dbPromise = new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);

		request.onupgradeneeded = (event) => {
			const db = event.target.result;
			const oldVersion = event.oldVersion;
			const transaction = event.target.transaction;

			const newConvStore = db.createObjectStore('conversations', { keyPath: 'id', autoIncrement: true });
			newConvStore.createIndex('time', 'time', { unique: false });

			const newMsgStore = db.createObjectStore('messages_v2', { keyPath: 'id', autoIncrement: true });
			newMsgStore.createIndex('owner', 'owner');
			newMsgStore.createIndex('parent', 'parent');

			if (oldVersion === 1) {
				try {
					// 2. 获取旧数据源
					const oldIndexStore = transaction.objectStore('index');
					const oldMessagesStore = transaction.objectStore('messages');

					let migrateIndex = 0;

					// 3. 开始迁移逻辑
					oldIndexStore.openCursor().onsuccess = (e) => {
						const cursor = e.target.result;
						if (cursor) {
							/**
							 * 辅助函数：将线性数组转为链式存储
							 * @type {AiChat.Conversation}
							 */
							const oldConv = cursor.value;
							const oldMsgId = oldConv.messageId;

							// 读取旧的大数组
							oldMessagesStore.get(oldMsgId).onsuccess = (msgEv) => {
								/**
								 * @type {{
								 *     messages: AiChat.Message[]
								 * }}
								 */
								const msgData = msgEv.target.result;
								if (msgData && msgData.messages) {
									// 顺序插入消息，建立 parentId 关系
									msgData.messages.forEach((msg, index) => {
										const newMsg = {
											...msg,
											owner: oldConv.id,
											id: migrateIndex,
										};

										if (newMsg.reasoning_details) {
											delete newMsg.think?.content;
											newMsg.reasoning_details = mergeReasoningDetails(newMsg.reasoning_details);
										}

										if (index > 0) newMsg.parent = migrateIndex - 1;

										migrateIndex++;
										newMsgStore.add(newMsg);
									});
									newConvStore.add({
										...(oldConv),
										lastMessage: migrateIndex - 1
									});
								}
							};
							cursor.continue();
						} else {
							db.deleteObjectStore('index');
							db.deleteObjectStore('messages');
						}
					};
				} catch (e) {
					transaction.abort();
					alert("数据库升级失败！");
					throw e;
				}
			}
		};

		request.onsuccess = (event) => {
			const db = event.target.result;
			// 长期持有连接时建议监听 close
			db.onversionchange = () => {
				db.close();
				console.warn('Database version change, please reload.');
			};
			resolve(db);
		};

		request.onerror = (event) => {
			reject(new Error(`Database error: ${event.target.error?.message || event.target.error}`));
		};
	});

	return dbPromise;
}

export function serializeMessage(message) {
	return JSON.stringify(message, function(key, value) {
		if (key === "id") return;
		return value;
	});
}

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export function getMessages(conversation) {
	return openDb().then(db => {
		return new Promise((resolve, reject) => {
			const tx = db.transaction('messages_v2', 'readonly');
			tx.onerror = (event) => reject(new Error(tx.error?.message || 'transaction failed'));

			const store = tx.objectStore('messages_v2');
			// 也可使用 IDBKeyRange.only()
			const request = store.index('owner').getAll(conversation.id);

			request.onsuccess = (event) => {
				const messages = event.target.result;

				/**
				 * @type {Map<number, string>}
				 */
				const m = new Map();
				conversation[CURRENT_IN_IDB] = m;

				for (let message of messages) {
					delete message.owner;
					m.set(message.id, serializeMessage(message));
				}

				// 如果需要按时间排序，这里可以再 sort 一下，或者存的时候按顺序存
				// messages.sort((a, b) => a.time - b.time);
				resolve(messages);
			}
		});
	});
}

/**
 * 新建一个会话
 * @returns {Promise<AiChat.Conversation>}
 */
export function newConversation() {
	return openDb().then((db) => {
		return new Promise((resolve, reject) => {
			const tx = db.transaction(['conversations'], 'readwrite');
			tx.onerror = () => reject(new Error(tx.error?.message || 'transaction failed'));

			const conversation = {
				title: "",
				time: Date.now(),
				[CURRENT_IN_IDB]: new Map
			};

			const addConvReq = tx.objectStore('conversations').add(conversation);
			addConvReq.onsuccess = (e) => {
				conversation.id = e.target.result;
				resolve(conversation);
			};
		});
	});
}

/**
 * 更新会话
 * @param {AiChat.Conversation} data
 * @param {AiChat.Message[]|false} messages=
 * @returns {Promise<boolean>}
 */
export function updateConversation(data, messages) {
	if (!data || typeof data.title !== 'string' || typeof data.time !== 'number' || typeof data.id !== 'number') {
		return Promise.reject(new Error('setConversation: invalid data'));
	}

	return openDb().then(db => {
		return new Promise((resolve, reject) => {
			const tx = db.transaction(['conversations', 'messages_v2'], 'readwrite');
			tx.onerror = () => reject(new Error(tx.error?.message || 'transaction failed'));
			tx.oncomplete = () => resolve(true);

			tx.objectStore('conversations').put({
				id: data.id,
				title: data.title,
				time: data.time
			});

			if (!messages) return;

			const messageStore = tx.objectStore('messages_v2');

			/**
			 * @type {Map<number, string>}
			 */
			const messagesInDB = data[CURRENT_IN_IDB];
			/**
			 * @type {Map<number, string>}
			 */
			const messagesInMemory = new Map();

			for (let i = 0; i < messages.length; i++){
				const message = messages[i];

				const newMessageKey = serializeMessage(message);
				if (message.id) {
					messagesInMemory.set(message.id, newMessageKey);

					const existingKey = messagesInDB.get(message.id);
					messagesInDB.delete(message.id);

					if (existingKey === newMessageKey) continue;
				}

				const value = {
					...message,
					owner: data.id
				};

				if (i) value.parent = messages[i-1].id;

				messageStore.put(value).onsuccess = (e) => {
					message.id = e.target.result;
					messagesInMemory.set(message.id, newMessageKey);
					//console.log("ADD", message);
				}
			}

			//if (messagesInDB.size) console.log("DEL", messagesInDB);
			messagesInDB.forEach((value, id) => messageStore.delete(id));

			data[CURRENT_IN_IDB] = messagesInMemory;
		});
	});
}

/**
 * 删除会话及其所有消息
 * @param {AiChat.Conversation} data
 * @returns {Promise<void>}
 */
export function deleteConversation(data) {
	return openDb().then(db => {
		return new Promise((resolve, reject) => {
			const tx = db.transaction(['conversations', 'messages_v2'], 'readwrite');
			tx.onerror = () => reject(new Error(tx.error?.message || 'transaction failed'));

			const conversationId = data.id;

			tx.objectStore('conversations').delete(conversationId);

			const msgStore = tx.objectStore('messages_v2');
			const cursorRequest = msgStore.index('owner').openKeyCursor(conversationId);
			cursorRequest.onsuccess = (event) => {
				const cursor = event.target.result;
				if (cursor) {
					msgStore.delete(cursor.primaryKey);
					cursor.continue();
				}
			};

			tx.oncomplete = resolve;
		});
	});
}

/**
 * 列出所有会话，按创建时间降序
 * @returns {Promise<Array<{id:number, title:string, time:number, messageId?:number}>>}
 */
export function listConversations() {
	return openDb().then((db) => {
		return new Promise((resolve, reject) => {
			const tx = db.transaction('conversations', 'readonly');
			tx.onerror = () => reject(new Error(tx.error?.message || 'listConversations failed'));

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
	});
}

/**
 * 搜索所有消息中包含 keyword 的会话（全量扫描）
 * @param {string} keyword 搜索关键词（不区分大小写）
 * @returns {Promise<Array<AiChat.Conversation & {matchingMessages: AiChat.Message[]}>>}
 */
export function searchMessages(keyword) {
	if (!keyword || typeof keyword !== 'string') {
		return Promise.resolve([]);
	}
	const lowerKeyword = keyword.toLowerCase();

	return listConversations().then(conversations => {
		const promises = conversations.map(conv =>
			getMessages(conv).then(messages => {
				if (!messages) return null;

				messages = messages.filter(msg => msg.content?.toLowerCase().includes(lowerKeyword));

				if (messages.length > 0) {
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