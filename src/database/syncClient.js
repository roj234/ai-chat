import {
	BRANCH_MANAGER,
	conversations,
	EVENT_BUS,
	findConversation,
	LOCKED,
	messages,
	resetConversation,
	runningConversations,
	selectedConversation,
	switchToConversation,
	updateConversationListUI,
	updateConversationUI,
	updateMessageUI
} from "../states.js";
import {decodeObjects, serializeJSON} from "../utils/marshal.js";
import {showToast} from "../components/Toast.js";
import {$computed, $state, $update, ONCE_EVENT, unconscious} from "unconscious";
import {DI, onLoad} from "../hooks.js";

import {
	SYNC_CONFLICT,
	SYNC_CONVERSATION,
	SYNC_CONVERSATION_DEL,
	SYNC_ERROR,
	SYNC_INIT,
	SYNC_KV,
	SYNC_KVS,
	SYNC_KVS_DEL,
	SYNC_LOCKED,
	SYNC_MESSAGE,
	SYNC_MESSAGE_DEL,
	SYNC_PING,
	SYNC_READERS,
	SYNC_RELEASED,
	SYNC_RESOLVE,
	SYNC_RPC,
	SYNC_UNLOCKED
} from "/backend/sync.js";
import {clearMessageDirty, DIFF_SNAPSHOT, listConversations, MESSAGES_CACHE} from "../database.js";
import {deepEqual, patch} from "unconscious/common/deepEqual.js";
import {decodeMsg} from "unconscious/common/msgpack.js";
import {msgpack_schema} from "/common/MsgpackSchema.js";
import {highlightJsonLike} from "../markdown/highlight.js";
import {prettyError} from "../utils/utils.js";
import {initialize, serializeMsgpack, serverAcceptMsgpack} from "./remoteDB.js";
import {enableBranches} from "../utils/BranchManager.js";

let body;

/** @type {function} */
let lockedToast;
let lockedToastOwner;

/** @type {WebSocket} */
let ws;

let pendingEvents = [];
let clientCounts;

/**
 *
 * @param {number} type
 * @param {any} data
 */
export const sendToSyncServer = (type, data) => {
	(serverAcceptMsgpack ? serializeMsgpack : serializeJSON)([type, data]).then(text => {
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(text);
		} else {
			pendingEvents.push(text);
		}
	});
};

const hideReadonlyUI = (id) => {
	if (id != null && lockedToastOwner !== id) return;
	lockedToast?.();
	lockedToast = null;
	lockedToastOwner = null;
	body.remove("_locked");
};

const showReadonlyUI = (id) => {
	if (lockedToastOwner === id) return;
	if (lockedToast) hideReadonlyUI();

	lockedToastOwner = id;

	const div = <button className={"ri-arrow-left-right-line warning"} style={"margin-left:8px"} onClick={() => {
		sendToSyncServer(SYNC_RESOLVE, id);
	}}>只读
		<div className={"tooltip down"}>{"对话被其它客户端打开\n接管控制权可能导致未保存的数据丢失"}</div>
	</button>;

	DI.title.append(div);
	const closer = () => div.remove();

	const cb = DI.RMI?.render(id);
	if (cb) lockedToast = () => (closer(), cb());
	else lockedToast = closer;

	body.add("_locked");
};

const setLockStatus = (id, locked) => {
	const conv = findConversation(id);
	if (!conv) return;
	conv[LOCKED] = locked;
	$update(updateConversationListUI);
};

const checkConcurrentModification = conv => {
	const convId = conv.id;
	if (convId && locks.has(convId) && !conv[LOCKED]) {
		showToast(`合并冲突：其它端修改了对话 #${convId}`, 'error');
	}
};

export const initSync = (address) => new Promise((resolve, reject) => {
	const RMI = DI.RMI;
	DI.lock = lock;
	DI.unlock = unlock;

	ws = new WebSocket(address);
	let closeToast;

	let timestamp;
	let heartbeat;
	let clientId;
	let serverError;

	ws.binaryType = 'arraybuffer';
	ws.onopen = () => {
		for (const bin of pendingEvents) ws.send(bin);
		pendingEvents = [];

		heartbeat = setInterval(() => {
			if (Date.now() - timestamp > 900000) {
				ws.send(`[${SYNC_PING}]`);
			}
		}, 60000);
	};
	ws.onclose = () => {
		reject();
		RMI?.close();
		lockedToast?.();
		lockedToast = null;
		stateListener = null;

		const lastSuccessful = heartbeat != null;
		if (lastSuccessful) {
			clearInterval(heartbeat);
			for (let key of locks.keys()) pendingEvents.push(`[${SYNC_LOCKED},${key}]`);
		}

		let lastTimestamp = 0;
		for (let conv of unconscious(conversations)) {
			lastTimestamp = Math.max(lastTimestamp, conv.time);
		}

		const html = $state(serverError ? highlightJsonLike(serverError) : '');
		const handler = () => {
			btn.disabled = true;
			btn.textContent = '连接中';
			Promise.all([listConversations(lastTimestamp), initialize()]).then(([arr]) => {
				conversations.value = arr;
				const id = selectedConversation.id;
				if (id != null) {
					const conv = arr.find(item => item.id === id);
					if (!conv) resetConversation(); // deleted
					else switchToConversation(conv);
				}
				closeToast();
			}).catch(err => {
				if (err.status !== 304) html.value = highlightJsonLike(prettyError(err));
				else closeToast();
			}).finally(() => {
				btn.disabled = false;
				btn.textContent = '重连';
			});
		};
		const btn = <button className={"btn primary"} onClick={handler}>重连</button>;

		closeToast = showToast(<>同步服务已断开 {btn}{<div title={"服务器错误"} dangerouslySetInnerHTML={html}></div>}</>, "error", 0);
		if (serverError) return;
		if (document.hidden) document.addEventListener("visibilitychange", handler, ONCE_EVENT);
		else if (lastSuccessful) handler();
	};
	ws.onmessage = async ({data: buf}) => {
		timestamp = Date.now();

		let [type, data] = typeof buf === 'string' ? JSON.parse(buf) : decodeMsg(new DataView(buf), { schema: msgpack_schema });
		data = await decodeObjects(data);
		switch (type) {
			case SYNC_RPC: RMI?.handle(data); break;
			case SYNC_ERROR: serverError = data; break;
			// 状态更新
			case SYNC_INIT: {
				let clients, locked, serverCounts;
				[clients, locked, clientId, serverCounts] = data;

				if (clientCounts && !deepEqual(clientCounts, serverCounts))
					location.reload();
				clientCounts = serverCounts;

				const set = new Set(locked);
				unconscious(conversations).forEach(item => item[LOCKED] = set.has(item.id));
				$update(updateConversationListUI);
				showToast("同步服务已连接 (+"+clients.length+")", "ok");

				RMI?.open(clients, clientId);
				stateListener = RMI?.state;
				resolve(clientId);

				if (lockedToastOwner) {
					const conv = findConversation(lockedToastOwner);
					if (!conv?.[LOCKED]) hideReadonlyUI();
				}

				if (selectedConversation[LOCKED]) {
					showReadonlyUI(selectedConversation.id, RMI);
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
			case SYNC_CONFLICT:
			case SYNC_RESOLVE: {
				setLockStatus(data, true);
				if (data === selectedConversation.id) {
					showReadonlyUI(data, RMI);
				}
			}
			break;
			case SYNC_RELEASED: {
				setLockStatus(data, false);
				if (data === selectedConversation.id) {
					selectedConversation.ready = false;
				}
				hideReadonlyUI(data);
			}
			break;
			// 消息状态更新
			case SYNC_MESSAGE:
			case SYNC_MESSAGE_DEL: {
				const {owner, ...message} = data;
				const conv = findConversation(owner);
				if (!conv) return;

				const bm = conv[BRANCH_MANAGER];
				let msg = bm?.messages || conv[MESSAGES_CACHE];
				const isCurrent = conv === unconscious(selectedConversation);
				if (!msg && isCurrent) msg = unconscious(messages);
				if (!msg) return;

				checkConcurrentModification(conv);

				const isUpdate = type === SYNC_MESSAGE;
				let nextEnd;

				const index = msg.findIndex(item => item.id === message.id);
				if (index >= 0) {
					if (isUpdate) patch(msg[index], message);
					else msg.splice(index, 1);
				} else if (isUpdate) {
					msg.push(nextEnd = message);
				}
				clearMessageDirty(conv, message.id, isUpdate && message);

				if (isCurrent) {
					if (bm) {
						bm.setLeaf(nextEnd || msg[conv.bm_leaf] || msg.at(-1), true);
						messages.value = bm.getMessages();
					}
					else $update(updateMessageUI);
				}
				break;
			}
			// 对话状态更新
			case SYNC_CONVERSATION:
			case SYNC_CONVERSATION_DEL: {
				const convId = data.id;
				const index = conversations.findIndex(item => item.id === convId);
				let conv, removed, lastTime, lastLeaf;
				if (index >= 0) {
					conv = conversations[index];
					lastLeaf = conv.bm_leaf;
					lastTime = conv.time;
				}

				try {
					conv = patch(conv, data);
				} catch {
					// 有可能失败，因为不一定所有的客户端都拿到了完整的对话对象，可能只有list时的 id time title 三项
				}

				// 如果时间没变化，就不插到开头（例如只修改标题）
				if (lastTime !== conv.time || type === SYNC_CONVERSATION_DEL) {
					if (index >= 0) conversations.splice(index, 1);
					removed = true;
				}

				const isCurrent = convId === selectedConversation.id;
				if (type === SYNC_CONVERSATION) {
					if (removed) conversations.unshift(conv);
					else $update(updateConversationListUI);

					$update(updateConversationUI);

					checkConcurrentModification(conv);
					// 清除变更标记
					if (conv[DIFF_SNAPSHOT]) {
						conv[DIFF_SNAPSHOT] = structuredClone(conv);
					}

					const msgs = conv[MESSAGES_CACHE];
					if (msgs) {
						if (conv.bm_leaf != null && !conv[BRANCH_MANAGER]) {
							const newMsgs = enableBranches(conv, msgs);
							if (unconscious(messages) === msgs) messages.value = newMsgs;
						} else if (isCurrent && lastLeaf !== conv.bm_leaf) {
							const bm = conv[BRANCH_MANAGER];
							bm.setLeaf(msgs[conv.bm_leaf] || msgs.at(-1), true);
							messages.value = bm.getMessages();
						}
					}

					if (!locks.has(convId)) {
						// 如果没有打开这些消息，那么清除消息缓存
						delete conv[MESSAGES_CACHE];
						delete conv[BRANCH_MANAGER];
					}
				}
				else if (isCurrent) {
					showToast("当前对话已被其它客户端删除", 'error', 0);
					resetConversation();
				}
			}
			break;
			case SYNC_KV: {
				clientCounts[0]++;
				const [key, value] = data;
				EVENT_BUS.post(['kv', key], value);
			}
			break;
			case SYNC_KVS:
			case SYNC_KVS_DEL: {
				clientCounts[0]++;
				const [kvsType, name] = data;
				EVENT_BUS.post(['kvs', kvsType, type === SYNC_KVS ? 'set': 'del'], name);
			}
			break;
		}
	}
});

let stateListener;

const readerCount = new Map;
/** @type {Map<number, number>} */
const locks = new Map;
const lock = (id) => {
	if (id == null) return;
	let lockCount = (locks.get(id) || 0);
	if (!lockCount) sendToSyncServer(SYNC_LOCKED, id);
	locks.set(id, lockCount + 1);
};
const unlock = (id) => {
	let lockCount = locks.get(id);
	if (!lockCount) return;
	if (lockCount === 1) {
		sendToSyncServer(SYNC_UNLOCKED, id);
		locks.delete(id);
		readerCount.delete(id);
	} else {
		locks.set(id, lockCount - 1);
	}
};

onLoad((app) => {
	body = app.classList;
	const originalDelete = runningConversations.delete.bind(runningConversations);
	const originalSet = runningConversations.set.bind(runningConversations);

	runningConversations.delete = (id) => {
		unlock(id);
		stateListener?.(id, 0);
		return originalDelete(id);
	}
	runningConversations.set = (id, value) => {
		if (!runningConversations.has(id)) {
			lock(id);
			stateListener?.(id, 1);
		}
		return originalSet(id, value);
	}

	$computed((oldValue) => {
		const conv = unconscious(selectedConversation);
		const convId = conv?.id;
		if (oldValue !== convId) {
			if (oldValue != null) {
				hideReadonlyUI();
				unlock(oldValue);
			}
			if (conv) {
				if (conv[LOCKED]) showReadonlyUI(convId);
				lock(convId);
			}
		}
		return convId;
	});
});
