import {debugSymbol} from 'unconscious';
import {config} from "./states.js";
import {deepEqual, delta} from "unconscious/common/deepEqual.js";
import {prettyError} from "./utils/utils.js";
import * as idb from "./database/db-indexeddb.js";
import * as remote from "./database/db-remote.js";
import {showToast} from "./components/Toast.js";
import {SETTINGS} from "./settings.js";
import {BRANCH_MANAGER} from "./utils/BranchManager.js";
import {LOCKED} from "./components/ConversationList.jsx";

export const DB_MESSAGES_DIFF = debugSymbol("DB_MESSAGES_DIFF");
export const DB_CONVERSATION_DIFF = debugSymbol("DB_CONVERSATION_DIFF");
export const DONE = Promise.resolve();

export const databaseError = err => {
	showToast("数据库错误!\n"+prettyError(err)+"\n更改可能丢失，建议从设置导出当前对话", 'error', 0);
};

export const isIDB = DB_MODE === 'local' || config.db_server === ':idb:';

if (DB_MODE !== 'local') {
	SETTINGS.push({
		id: "db_server",
		_tab: ["general", "data"],
		name: "数据库服务器",
		title: "提供文件管理、消息搜索、多租户等功能\n修改后需要刷新页面"+(DB_MODE === "mixed" ? "\n填写 :idb: 使用本地数据库" : ""),
		type: "input",
		pattern: (DB_MODE === "mixed" ? /^(?:(?:https?:\/\/)?.*\/api\/v2\/|:idb:$)/ : /^(?:https?:\/\/)?.*\/api\/v2\//),
		warning: "请输入合法的服务器地址",
		placeholder: "/api/v2/username"
	},{
		id: "db_pat",
		_tab: "data",
		type: "secret",
		placeholder: "个人访问密钥 (PAT)",
	});
}

const db = isIDB ? idb : remote;

export const {
	deleteDatabase,
	/**
	 * 列出所有会话，按创建时间降序
	 * @param {number=} lastTimestamp 304 时间戳
	 * @returns {Promise<Array<{id:number, title:string, time:number}>>}
	 */
	listConversations,
	getKV, setKV,
	kvListGetValues, kvListSet, kvListDel, kvListGetKeys, kvListGet,
	searchMessages,
	uploadBlob, getBlob
} = db;


/**
 * 清除对话的脏标记
 * @param {AiChat.Conversation} conversation 对话
 * @param {number} id
 * @param {AiChat.Message} message
 */
export const clearDirtyFlags = (conversation, id, message) => {
	/** @type {Map<number, AiChat.Message>} */
	const m = conversation[DB_MESSAGES_DIFF];
	if (message) m.set(id, structuredClone(message));
	else m.delete(id);
}

/**
 * 获取一个会话的消息
 * @param {AiChat.Conversation} conversation 对话
 * @returns {Promise<AiChat.Message[]>}
 */
export const getMessages = conversation => (
	db.getMessages(conversation).then(messages => {
		/** @type {Map<number, AiChat.Message>} */
		const m = new Map();

		conversation[DB_CONVERSATION_DIFF] = structuredClone(conversation);
		conversation[DB_MESSAGES_DIFF] = m;

		for (let message of messages) {
			delete message.owner;
			m.set(message.id, structuredClone(message));
		}

		return messages;
	})
);

const DIFF_IGNORE_KEYS = new Set(["id", "ready"]);
const WAITING = debugSymbol("UPDATE_WAIT")

/**
 * 更新会话
 * @param {AiChat.Conversation} conversation
 * @param {AiChat.Message[]|false=} messages
 * @param {boolean=} keepTime
 * @returns {Promise<void>}
 */
export const updateConversation = async (conversation, messages, keepTime) => {
	if (config.incognito || conversation[LOCKED]) return;

	const prevUpdate = conversation[WAITING];
	if (prevUpdate) await prevUpdate;

	let promises = [];
	let changed = (diff) => {
		changed = null;
		conversation[DB_CONVERSATION_DIFF] = structuredClone(conversation);
		const updateAndThen = db.upsertConversation(diff);
		promises.push(updateAndThen);
		return updateAndThen;
	};

	// 新对话
	if (!("id" in conversation)) {
		conversation[DB_MESSAGES_DIFF] = new Map;
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
		const messagesInDB = conversation[DB_MESSAGES_DIFF];
		/**
		 * @type {Map<number, AiChat.Message>}
		 */
		const messagesInMemory = new Map();

		for (let i = 0; i < messages.length; i++) {
			const message = messages[i];
			const id = message.id;
			if (id === -1) continue;

			let diff;
			if (id) {
				const snapshot = messagesInDB.get(id);
				messagesInDB.delete(id);

				diff = isIDB ? !deepEqual(snapshot, message, DIFF_IGNORE_KEYS) : delta(snapshot, message, DIFF_IGNORE_KEYS);
				if (!diff) {
					messagesInMemory.set(id, snapshot);
					continue;
				}
			} else {
				// 新消息防止重复入库
				message.id = -1;
			}

			if (!keepTime) conversation.time = Date.now();

			let snapshot = structuredClone(message);
			if (id) messagesInMemory.set(id, snapshot);

			// 后面会写 owner 字段，浅拷贝
			if (typeof diff !== 'object') diff = {...snapshot};

			function save() {
				if (id != null) diff.id = id;
				else delete diff.id;
				diff.owner = conversation.id;
				const saveTime = message.time;

				return db.upsertMessage(diff).then((id) => {
					message.id = id;
					// messagesInMemory 可能已经变了，取最新的值
					conversation[DB_MESSAGES_DIFF].set(id, snapshot);

					// 消息在RTT内又修改了，重新更新
					if (message.time !== saveTime) {
						diff = delta(snapshot, message, DIFF_IGNORE_KEYS);
						if (diff) return save();
					}
				});
			}
			promises.push(save().finally(() => {
				// 如果新消息保存失败，不要阻止后续保存
				if (message.id === -1) delete message.id;
			}));
		}

		if (messagesInDB.size) {
			if (!keepTime) conversation.time = Date.now();
			messagesInDB.forEach((value, id) => promises.push(db.deleteMessage(id, conversation)));
		}

		conversation[DB_MESSAGES_DIFF] = messagesInMemory;
	}

	let convDiff;
	if (changed && (convDiff = isIDB ? (!deepEqual(conversation[DB_CONVERSATION_DIFF], conversation, DIFF_IGNORE_KEYS) && conversation) : delta(conversation[DB_CONVERSATION_DIFF], conversation, DIFF_IGNORE_KEYS))) {
		convDiff.id = conversation.id;
		changed(convDiff);
	}

	const wait = Promise.all(promises).catch(databaseError);
	conversation[WAITING] = wait;
	await wait;
	delete conversation[WAITING];
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

export const getBillingLog = id => {
	if (id == null) return DONE;
	return db.getBillingLog(id);
};