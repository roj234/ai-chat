
const DB_NAME = 'AiChat';
const DB_VERSION = 1;

let dbPromise;

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

			const indexStore = db.createObjectStore('index', {
				keyPath: 'id',
				autoIncrement: true,
			});
			indexStore.createIndex('time', 'time', { unique: false });

			// 消息表：主键为自增 id
			db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
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

/**
 * 事务的安全创建（带权重的 onupgradeneeded 中也可用）
 * @param {IDBDatabase} db
 * @param {string|string[]} storeNames
 * @param {"readonly"|"readwrite"} mode
 * @returns {IDBTransaction}
 */
function transactionSafe(db, storeNames, mode = 'readonly') {
	return db.transaction(storeNames, mode);
}

/**
 * 获取一个会话（包含 title/time/最新消息 id）
 * @param {number} id 消息 id（自增主键）
 * @returns {Promise<{id: number, messages: AiChat.Message[]}>}
 */
export function getMessages(id) {
	return openDb().then((db) => {
		return new Promise((resolve, reject) => {
			const tx = transactionSafe(db, 'messages', 'readonly');
			const store = tx.objectStore('messages');
			const request = store.get(Number(id));

			request.onsuccess = (event) => resolve(event.target.result);
			request.onerror = (event) => reject(new Error(event.target.error?.message || 'getMessages failed'));
		});
	});
}

/**
 * 新建一个会话及其首条消息
 * @returns {Promise<AiChat.Conversation>}
 */
export function newConversation() {
	return openDb().then((db) => {
		return new Promise((resolve, reject) => {
			const tx = transactionSafe(db, ['index', 'messages'], 'readwrite');
			const indexStore = tx.objectStore('index');
			const messageStore = tx.objectStore('messages');

			// 1) 先写入消息
			const addMsgReq = messageStore.add({ messages: [] });

			addMsgReq.onsuccess = (event) => {
				const messageId = event.target.result; // 自增消息主键

				// 2) 再写入会话并关联最新消息 id
				const conversationData = {
					title: "",
					time: Date.now(),
					messageId: messageId
				};
				const addConvReq = indexStore.add(conversationData);

				addConvReq.onsuccess = (e) => {
					conversationData.id = e.target.result;
					resolve(conversationData);
				};

				addConvReq.onerror = (e) => reject(new Error(e.target.error?.message || 'add conversation failed'));
			};

			addMsgReq.onerror = (event) => reject(new Error(event.target.error?.message || 'add message failed'));
			tx.onerror = (event) => reject(new Error(tx.error?.message || 'transaction failed'));
		});
	});
}

/**
 * 更新会话（若传了 id 则更新现有会话；未传 id 则作为新会话创建）
 * @param {AiChat.Conversation} data
 * @param {AiChat.Message[]} messages=
 * @returns {Promise<boolean>}
 */
export function setConversation(data, messages) {
	if (!data || typeof data.title !== 'string' || typeof data.time !== 'number'  || typeof data.messageId !== 'number') {
		return Promise.reject(new Error('setConversation: invalid data'));
	}

	return openDb().then(db => {
		return new Promise((resolve, reject) => {
			const tx = transactionSafe(db, ['index', 'messages'], 'readwrite');
			tx.onerror = (event) => reject(new Error(tx.error?.message || 'transaction failed'));

			const indexStore = tx.objectStore('index');
			const messageStore = tx.objectStore('messages');

			const updateReq = indexStore.put({
				id: Number(data.id),
				title: data.title,
				time: data.time,
				messageId: data.messageId,
			});

			updateReq.onsuccess = () => {
				if (!messages) {
					resolve(true);
					return;
				}

				// 写入新消息
				const addMsgReq = messageStore.put({ messages: messages, id: data.messageId });
				addMsgReq.onsuccess = (event) => {
					resolve(true);
				};
				addMsgReq.onerror = (event) => reject(new Error(event.target.error?.message || 'add message failed'));
			};
			updateReq.onerror = (e) => reject(new Error(e.target.error?.message || 'put conversation failed'));
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
			const tx = transactionSafe(db, ['index', 'messages'], 'readwrite');
			tx.onerror = (event) => reject(new Error(tx.error?.message || 'transaction failed'));

			const indexStore = tx.objectStore('index');
			const messageStore = tx.objectStore('messages');

			const delMsgReq = messageStore.delete(Number(data.messageId));
			delMsgReq.onsuccess = () => {
				const delConvReq = indexStore.delete(Number(data.id));
				delConvReq.onsuccess = () => resolve();
				delConvReq.onerror = (e) => reject(new Error(e.target.error?.message || 'delete conversation failed'));
			};
			delMsgReq.onerror = (e) => reject(new Error(e.target.error?.message || 'delete message failed'));

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
			const tx = transactionSafe(db, 'index', 'readonly');
			tx.onerror = (event) => reject(new Error(tx.error?.message || 'listConversations failed'));

			const indexStore = tx.objectStore('index');
			const idx = indexStore.index('time');

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
			getMessages(conv.messageId).then(messagesObj => {
				if (!messagesObj || !messagesObj.messages) return null;

				const messages = messagesObj.messages.filter(msg =>
					msg.content?.toLowerCase().includes(lowerKeyword)
				);

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