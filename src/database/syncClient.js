import {
	conversations,
	EVENT_BUS,
	findConversation,
	LOCKED,
	messages,
	resetConversation,
	selectedConversation,
	switchToConversation,
	updateConversationListUI,
	updateConversationUI,
	updateMessageUI
} from "../states.js";
import {decodeObjects, serializeJSON} from "../utils/serialization.js";
import {showToast} from "../components/Toast.js";
import {$computed, $state, $update, ONCE_EVENT, unconscious} from "unconscious";
import {DI, DID_RMI, DID_TITLE_POSITION, onLoad} from "../hooks.js";

import {
	SYNC_CONFLICT,
	SYNC_CONVERSATION,
	SYNC_CONVERSATION_DEL,
	SYNC_DM,
	SYNC_DM_QUERY,
	SYNC_ERROR,
	SYNC_INIT,
	SYNC_KV,
	SYNC_KVS,
	SYNC_KVS_DEL,
	SYNC_LOCKED,
	SYNC_MESSAGE,
	SYNC_MESSAGE_DEL,
	SYNC_PING,
	SYNC_RELEASED,
	SYNC_RESOLVE,
	SYNC_RPC,
	SYNC_UNLOCKED
} from "/backend/sync.js";
import {clearMessageDirty, DIFF_SNAPSHOT, getImmediateMessages, listConversations} from "../database.js";
import {deepEqual, patch} from "unconscious/common/deepEqual.js";
import {decodeMsg} from "unconscious/common/msgpack.js";
import {msgpack_schema} from "/common/wire-compression-schema.js";
import {highlightJsonLike} from "../markdown/highlight.js";
import {prettyError} from "../utils/utils.js";
import {initialize, serializeMsgpack, serverAcceptMsgpack} from "./remoteDB.js";
import {enableBranches} from "../utils/BranchManager.js";
import {setConversationTitle} from "../components/ConversationList.jsx";
import {conversationLock, lockConversation, unlockConversation} from "../conversation-lock.js";

let bodyClass;

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
	bodyClass.remove("_locked");
};

const showReadonlyUI = (id) => {
	if (lockedToastOwner === id) return;
	if (lockedToast) hideReadonlyUI();

	lockedToastOwner = id;

	const div = <button className={"ri-arrow-left-right-line warning"} style={"margin-left:8px;flex-shrink:0"} onClick={() => {
		sendToSyncServer(SYNC_RESOLVE, id);
	}}>只读
		<div className={"tooltip down"}>{"对话被其它客户端打开\n接管控制权可能导致未保存的数据丢失"}</div>
	</button>;

	DI[DID_TITLE_POSITION].append(div);
	const closer = () => div.remove();

	const cb = DI[DID_RMI]?.render(id);
	if (cb) lockedToast = () => (closer(), cb());
	else lockedToast = closer;

	bodyClass.add("_locked");
};

const setLockStatus = (id, locked) => {
	const conv = findConversation(id);
	if (!conv) return;
	conv[LOCKED] = locked;
	$update(updateConversationListUI);
	if (locked) {
		if (id === selectedConversation.id) {
			showReadonlyUI(id);
		}
	} else {
		hideReadonlyUI(id);
	}
};

const checkConcurrentModification = conv => {
	const convId = conv.id;
	if (convId && conversationLock.has(convId) && !conv[LOCKED]) {
		showToast(`合并冲突：其它端修改了对话 #${convId}`, 'error');
	}
};

export const initSync = (address) => new Promise((resolve, reject) => {
	const RMI = DI[DID_RMI];

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

		EVENT_BUS.post(['syncBegin'], sendToSyncServer);
	};
	ws.onclose = () => {
		reject();
		RMI?.close();
		EVENT_BUS.post(['syncEnd']);

		const lastSuccessful = heartbeat != null;
		if (lastSuccessful) {
			clearInterval(heartbeat);
			for (let key of conversationLock.keys()) pendingEvents.push(`[${SYNC_LOCKED},${key}]`);
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
			}, err => {
				if (err.status !== 304) html.value = highlightJsonLike(prettyError(err));
				else closeToast();
			}).finally(() => {
				btn.disabled = false;
				btn.textContent = '重连';
			});
		};
		const btn = <button className={"btn primary"} onClick={handler}>重连</button>;

		closeToast = showToast(<div>同步服务已断开 {btn}{<div title={"服务器错误"} dangerouslySetInnerHTML={html}></div>}</div>, "error", 0);
		if (serverError) return;
		if (document.hidden) document.addEventListener("visibilitychange", handler, ONCE_EVENT);
		else if (lastSuccessful) handler();
	};
	ws.onmessage = async ({data: buf}) => {
		timestamp = Date.now();

		let [type, data] = typeof buf === 'string' ? JSON.parse(buf) : decodeMsg(new DataView(buf), { schema: msgpack_schema });
		data = await decodeObjects(data);
		switch (type) {
			case SYNC_DM_QUERY: EVENT_BUS.post(['dm-query'], data); break;
			case SYNC_DM: EVENT_BUS.post(['dm', data[0]], data); break;

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
				resolve(clientId);

				if (lockedToastOwner) {
					const conv = findConversation(lockedToastOwner);
					if (!conv?.[LOCKED]) hideReadonlyUI();
				}

				if (selectedConversation[LOCKED]) {
					showReadonlyUI(selectedConversation.id);
				}
			}
			break;
			/*case SYNC_READERS: {
				const [id, count] = data;
				showToast("对话 "+id+" 现在"+(count?"有":"无")+"读者");
			}
			break;*/
			case SYNC_LOCKED:
			case SYNC_UNLOCKED: {
				setLockStatus(data, type !== SYNC_UNLOCKED);
			}
			break;
			// 独占锁和冲突处理
			case SYNC_CONFLICT:
			case SYNC_RESOLVE: {
				setLockStatus(data, true);
			}
			break;
			case SYNC_RELEASED: {
				setLockStatus(data, false);
				if (data === selectedConversation.id) {
					selectedConversation.ready = false;
					$update(updateMessageUI);
				}
			}
			break;
			// 消息状态更新
			case SYNC_MESSAGE:
			case SYNC_MESSAGE_DEL: {
				const {owner, ...message} = data;
				const conv = findConversation(owner);
				if (!conv) return;

				const msg = getImmediateMessages(conv);
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

				const isCurrent = conv === unconscious(selectedConversation);
				if (isCurrent) $update(updateMessageUI);
				break;
			}
			// 对话状态更新
			case SYNC_CONVERSATION:
			case SYNC_CONVERSATION_DEL: {
				const convId = data.id;
				const index = conversations.findIndex(item => item.id === convId);
				let conv = conversations[index], moved;

				try {
					conv = patch(conv, data);
				} catch {
					if (conv === undefined) {
						showToast(`对话数据 ${convId} 不同步`, "error");
						return;
					}
					// 有可能失败，因为不一定所有的客户端都拿到了完整的对话对象，可能只有list时的 id time title 三项
				}
				const diff = data.$ === '=' ? data.v : data;

				// 如果时间没变化，就不插到开头（例如只修改标题）
				if (diff.time != null || type === SYNC_CONVERSATION_DEL) {
					if (index >= 0) conversations.splice(index, 1);
					moved = true;
				}

				const isCurrent = convId === selectedConversation.id;
				if (type === SYNC_CONVERSATION) {
					if (moved) conversations.unshift(conv);
					else {
						$update(updateConversationListUI);
						if (diff.meta != null) $update(conversations);
					}

					$update(updateConversationUI);

					checkConcurrentModification(conv);
					// 清除变更标记
					if (conv[DIFF_SNAPSHOT]) {
						conv[DIFF_SNAPSHOT] = structuredClone(conv);
					}

					if (diff.title != null) setConversationTitle(conv, conv.title, true);

					const msgs = getImmediateMessages(conv);
					if (msgs) {
						if (conv.bm_leaf != null) {
							let bm = enableBranches(conv);
							if (bm !== msgs && isCurrent) messages.value = bm;
							bm.setLeaf(msgs[conv.bm_leaf] ?? msgs.at(-1), true);
							if (isCurrent) $update(updateMessageUI);
						} else {
							// 刷新了也会自己关闭的，不管
						}
					}
				}
				else if (isCurrent) {
					showToast("当前对话已被其它客户端删除", 'error', 0);
					setLockStatus(convId, "DELETED");
					showReadonlyUI(convId);
					EVENT_BUS.post(['convDel', conv.id]);
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
				const [kvsType, name, meta] = data;
				EVENT_BUS.post(['kvs', kvsType, type === SYNC_KVS ? 'set': 'del'], name, meta);
			}
			break;
		}
	}
});

EVENT_BUS.on('lock', (id) => {sendToSyncServer(SYNC_LOCKED, id);});
EVENT_BUS.on('unlock', (id) => {sendToSyncServer(SYNC_UNLOCKED, id);});

onLoad((app) => {
	bodyClass = app.classList;

	$computed((oldValue) => {
		const conv = unconscious(selectedConversation);
		const convId = conv?.id;
		if (oldValue !== convId) {
			if (oldValue != null) {
				hideReadonlyUI();
				unlockConversation(oldValue);
			}
			if (conv) {
				if (conv[LOCKED]) showReadonlyUI(convId);
				lockConversation(convId);
			}
		}
		return convId;
	});
});
