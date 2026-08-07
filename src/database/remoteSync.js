import {
	BRANCH_MANAGER,
	conversations,
	LOCKED,
	messages,
	resetConversation,
	runningConversations,
	selectedConversation,
	updateConversationListUI,
	updateConversationResumeState,
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
} from "/backend/sync_const.js";
import {clearMessageDirty, CONVERSATION_SNAPSHOT, listConversations, MESSAGES_CACHE} from "../database.js";
import {deepEqual, patch} from "unconscious/common/deepEqual.js";
import {decodeMsg} from "unconscious/common/msgpack.js";
import {msgpack_schema} from "/common/MsgpackSchema.js";
import {highlightJsonLike} from "../markdown/highlight.js";
import {prettyError} from "../utils/utils.js";
import {initialize} from "./remoteDB.js";

let body;

/** @type {function} */
let readonlyToast;

/** @type {WebSocket} */
let ws;

let pendingEvents = [];
let clientIds;

/**
 *
 * @param {number} type
 * @param {any} data
 * @param {boolean} [rawString]
 */
export const sendToSyncServer = (type, data, rawString) => {
	if (type === SYNC_MESSAGE && !readerCount.get(selectedConversation.id)) return;

	if (ws?.readyState === WebSocket.OPEN) {
		if (typeof data === 'object') {
			serializeJSON(data).then(text => sendToSyncServer(type, text, true));
		} else {
			ws.send("["+type+","+(typeof data !== 'string' || rawString ? data : JSON.stringify(data))+"]");
		}
	} else {
		pendingEvents.push([type, data, rawString]);
	}
};

const setWritable = (id) => {
	if (id != null && setCurrentLocked(0, id)) return;
	readonlyToast?.();
	readonlyToast = null;
	body.remove("_readonly");
};

const setReadonly = (id, rpc) => {
	if (setCurrentLocked(1, id)) return;
	readonlyToast = showToast(<>
		<div>
			<b>只读</b>&nbsp;
			<button className={"btn danger"} style={"position:relative"} onClick={() => {
				sendToSyncServer(SYNC_RESOLVE, id);
				setWritable(id);
			}}>获取编辑权限
				<div className={"tooltip"}>对话被其它客户端打开<br/>解锁可能导致数据丢失</div>
			</button>
		</div>
		{rpc?.render(id)}
	</>, '', -1);
	body.add("_readonly");
};

const setCurrentLocked = (locked, id) => {
	const id1 = selectedConversation.id;
	if (id1 == null || (id != null && id1 !== id)) return true;
	selectedConversation[LOCKED] = locked;
	$update(updateConversationListUI);
};

const findConversation = (id) => {
	const conv = unconscious(selectedConversation);
	return conv?.id !== id ? unconscious(conversations).find(item => item.id === id) : conv;
};

const checkConcurrentModification = conv => {
	const convId = conv.id;
	if (locks.has(convId) && !conv[LOCKED]) {
		showToast(`合并冲突：其它端修改了对话 #${convId}`, 'error');
	}
};

export const initSync = (address, kvRef, kvCache, rpc) => new Promise((resolve, reject) => {
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
		for (const arr of pendingEvents) sendToSyncServer(...arr);
		pendingEvents = [];

		heartbeat = setInterval(() => {
			if (Date.now() - timestamp > 900000) {
				ws.send(`[${SYNC_PING}]`);
			}
		}, 60000);
	};
	ws.onclose = () => {
		reject();
		rpc?.close();
		stateListener = null;

		const lastSuccessful = heartbeat != null;
		if (lastSuccessful) {
			clearInterval(heartbeat);
			for (let key of locks.keys()) pendingEvents.push([SYNC_LOCKED, key]);
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
				if (id != null) selectedConversation.value = arr.find(item => item.id === id);
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
			case SYNC_RPC: rpc?.handle(data); break;
			case SYNC_ERROR:  serverError = data; break;
			// 状态更新
			case SYNC_INIT: {
				let clients, locked, serverIds;
				[clients, locked, clientId, serverIds] = data;

				if (clientIds && !deepEqual(clientIds, serverIds))
					location.reload();
				clientIds = serverIds;

				const set = new Set(locked);
				unconscious(conversations).forEach(item => item[LOCKED] = set.has(item.id));
				$update(updateConversationListUI);
				showToast("同步服务已连接 ("+clients.length+")", "ok");

				rpc?.open(clients, clientId);
				stateListener = rpc?.state;
				resolve(clientId);
			}
			break;
			case SYNC_READERS: {
				const [id, count] = data;
				readerCount.set(id, count > 0);
			}
			break;
			case SYNC_LOCKED:
			case SYNC_UNLOCKED: {
				const conv = unconscious(conversations).find(item => item.id === data);
				if (conv) {
					conv[LOCKED] = type === SYNC_LOCKED;
					$update(updateConversationListUI);
				}
			}
			break;
			// 独占锁和冲突处理
			case SYNC_CONFLICT: {
				setReadonly(data, rpc);
			}
			break;
			case SYNC_RESOLVE: {
				if (selectedConversation.id === data) {
					setReadonly(data, rpc);
				}
			}
			break;
			case SYNC_RELEASED: {
				if (data === selectedConversation.id) {
					selectedConversation.ready = false;
				}
				setWritable(data);
			}
			break;
			// 消息状态更新
			case SYNC_MESSAGE:
			case SYNC_MESSAGE_DEL: {
				const {owner, ...message} = data;
				const conv = findConversation(owner);
				if (!conv) return;

				const bm = conv[BRANCH_MANAGER];
				const msg = bm?.messages || conv[MESSAGES_CACHE];
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

				if (conv === unconscious(selectedConversation)) {
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
				let conv, removed, lastTime;
				if (index >= 0) {
					conv = conversations[index];
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

				const isCurrentViewing = convId === selectedConversation.id;
				if (type === SYNC_CONVERSATION) {
					if (removed) conversations.unshift(conv);
					else $update(updateConversationListUI);

					$update(updateConversationResumeState);

					checkConcurrentModification(conv);
					// 清除变更标记
					if (conv[CONVERSATION_SNAPSHOT]) {
						conv[CONVERSATION_SNAPSHOT] = structuredClone(conv);
					}
					if (!locks.has(convId)) {
						// 如果没有打开这些消息，那么清除消息缓存
						delete conv[MESSAGES_CACHE];
					}
				}
				else if (isCurrentViewing) {
					showToast("当前对话已被其它客户端删除", 'error', 0);
					resetConversation();
				}
			}
			break;
			case SYNC_KV: {
				clientIds[0]++;
				const [key, value] = data;
				const val = kvRef.get(key);
				if (val) val.value = value;
			}
			break;
			case SYNC_KVS:
			case SYNC_KVS_DEL: {
				clientIds[0]++;
				const [kvsType, name] = data;
				kvCache.delete(kvsType+':'+name);

				const val = kvRef.get(':'+kvsType);
				if (val) {
					const idx = unconscious(val).findIndex(item => item.name === name);
					if (type === SYNC_KVS_DEL) {
						val.splice(idx, 1);
					} else if (idx < 0) {
						val.unshift({name});
					}
				}
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
				setWritable();
				unlock(oldValue);
			}
			if (conv) lock(convId);
		}
		return convId;
	});
});
