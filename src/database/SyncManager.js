import {beginConversation, conversations, messages, runningConversations, selectedConversation} from "../states.js";
import {decodeObjects, serializeJSON} from "../utils/marshal.js";
import {showToast} from "../components/Toast.js";
import {$computed, $update, unconscious} from "unconscious";
import {onLoad} from "../plugin.js";
import {LOCKED, updateConversationListUI} from "../components/ConversationList.jsx";

import {
	SYNC_CONFLICT,
	SYNC_CONVERSATION,
	SYNC_INIT,
	SYNC_LOCKED,
	SYNC_MESSAGE,
	SYNC_PING,
	SYNC_READERS,
	SYNC_RELEASED,
	SYNC_RESOLVE,
	SYNC_UNLOCKED
} from "/backend/sync_const.js";
import {updateMessageUI} from "../components/MessageList.jsx";
import {clearDirtyFlags} from "../database.js";

export {SYNC_MESSAGE, SYNC_CONVERSATION};

let body;

/** @type {function} */
let readonlyToast;

/** @type {WebSocket} */
let ws;

let pendingEvents = [];

/**
 *
 * @param {number} type
 * @param {any} data
 * @return {Promise<void>}
 */
const on = async (type, data) => {
	if (type === SYNC_MESSAGE && !readerCount.get(selectedConversation.id)) return;

	if (ws?.readyState === WebSocket.OPEN) {
		ws.send("["+type+","+(typeof data === "number" ? data : await serializeJSON(data))+"]");
	} else {
		pendingEvents.push([type, data]);
	}
};

const setWritable = (id) => {
	if (readonlyToast) readonlyToast();
	readonlyToast = null;
	body.remove("_readonly");
	setCurrentLocked(0, id);
};

const setReadonly = (id) => {
	readonlyToast = showToast(<>只读模式<br/>
		该对话已被其它客户端打开<br/>
		<button className={"btn danger"} onClick={() => {
			on(SYNC_RESOLVE, id);
			setWritable(id);
		}}>强制解锁
		</button>
	</>, 'error', 0);
	body.add("_readonly");
	setCurrentLocked(1, id);
};

const findConversation = id => {
	const convList = unconscious(conversations);
	const index = convList.findIndex(item => item.id === id);
	return convList[index];
};

const setCurrentLocked = (locked, id) => {
	const id1 = selectedConversation.id;
	if (id1 == null || (id != null && id1 !== id)) return;
	selectedConversation[LOCKED] = locked;
	$update(updateConversationListUI);
};

export function initSync(address) {
	ws = new WebSocket(address);

	let timestamp;
	const updater = setInterval(() => {
		if (Date.now() - timestamp > 900000) {
			ws.send(`[${SYNC_PING}]`);
		}
	}, 60000);

	ws.onopen = () => {
		for (const [type, data] of pendingEvents) on(type, data);
		pendingEvents = [];
	};
	ws.onclose = () => {
		showToast(<>同步服务已断开 <button className={"btn primary"} onClick={() => {
			location.reload();
		}}>刷新</button></>, "error", 0);
		clearInterval(updater);
	};
	ws.onmessage = async (event) => {
		timestamp = Date.now();

		let [type, data] = JSON.parse(event.data);
		data = await decodeObjects(data);
		switch (type) {
			// 状态更新
			case SYNC_INIT: {
				const [clients, locked] = data;
				showToast("同步服务已连接, 共 "+clients+" 个客户端", "ok");
				if (locked.length) {
					for (const item of locked) {
						const conv = findConversation(item);
						if (conv) conv[LOCKED] = 1;
					}
					$update(updateConversationListUI);
				}
			}
			break;
			case SYNC_READERS: {
				const [id, count] = data;
				readerCount.set(id, count > 0);
			}
			break;
			case SYNC_LOCKED:
			case SYNC_UNLOCKED: {
				const conv = findConversation(data);
				if (conv) {
					conv[LOCKED] = type === SYNC_LOCKED;
					$update(updateConversationListUI);
				}
			}
			break;
			// 独占锁和冲突处理
			case SYNC_CONFLICT: {
				setReadonly(data);
			}
			break;
			case SYNC_RESOLVE: {
				if (selectedConversation.id === data) {
					setReadonly(data);
				}
			}
			break;
			case SYNC_RELEASED: {
				if (data === selectedConversation.id) {
					selectedConversation.ready = false;
					setWritable(data);
				}
			}
			break;
			// 消息状态更新
			case SYNC_MESSAGE: {
				const {owner, ...message} = data;
				const isUpdate = Object.keys(message).length > 1;

				const conv = unconscious(selectedConversation);
				const msg = unconscious(messages);

				const index = msg.findIndex(item => item.id === message.id);
				if (index >= 0) {
					if (isUpdate) msg[index] = message;
					else msg.splice(index, 1);
				} else if (isUpdate && conv.id === owner) {
					msg.push(message);
				}
				clearDirtyFlags(conv, message.id, isUpdate && message);
				$update(updateMessageUI);
				break;
			}
			// 对话状态更新
			case SYNC_CONVERSATION: {
				const isUpdate = Object.keys(data).length > 1;

				const index = conversations.findIndex(item => item.id === data.id);
				if (index >= 0) data = Object.assign(conversations.splice(index, 1)[0], data);
				if (isUpdate) conversations.unshift(data);
				else {
					if (data.id === selectedConversation.id) {
						showToast("当前对话已被其它客户端删除", 'error', 0);
						beginConversation();
					}
				}
			}
			break;
		}
	}

	return { on }
}

const readerCount = new Map;
/** @type {Map<number, number>} */
const locks = new Map;
const lock = (id) => {
	let lockCount = (locks.get(id) || 0);
	if (!lockCount) on(SYNC_LOCKED, id);
	locks.set(id, lockCount + 1);
};
const unlock = (id) => {
	let lockCount = locks.get(id);
	if (!lockCount) return;
	if (lockCount === 1) {
		on(SYNC_UNLOCKED, id);
		locks.delete(id);
		readerCount.delete(id);
	} else {
		locks.set(id, lockCount - 1);
	}
}

onLoad((app) => {
	body = app.classList;
	const originalDelete = runningConversations.delete.bind(runningConversations);
	const originalSet = runningConversations.set.bind(runningConversations);

	runningConversations.delete = (id) => {
		unlock(id);
		return originalDelete(id);
	}
	runningConversations.set = (id, value) => {
		if (!runningConversations.has(id)) lock(id);
		return originalSet(id, value);
	}

	$computed((oldValue) => {
		const conv = unconscious(selectedConversation);
		const convId = conv?.id;
		if (oldValue !== convId) {
			if (oldValue != null) {
				setWritable();
				unlock(oldValue);
			}
			if (conv) lock(convId);
		}
		return convId;
	});
});
