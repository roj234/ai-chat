import {beginConversation, conversations, selectedConversation} from "../states.js";
import {decodeObjects} from "../utils/marshal.js";
import {showToast} from "../components/Toast.js";
import {$watch, unconscious} from "unconscious";
import SimpleModal from "../components/SimpleModal.jsx";
import {onLoad} from "../plugin.js";
import {serializeJSON} from "./db-remote.js";

let closeToast;

/** @type {number} */
let forceUnlockId;
/** @type {function} */
let conversationMessage;

/** @type {WebSocket} */
let ws;

let pendingEvents = [];

async function on(type, data) {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(await serializeJSON({type, data}));
	} else {
		pendingEvents.push([type, data]);
	}
}

export function initSync(address) {
	ws = new WebSocket(address);
	ws.onopen = () => {
		for (const [type, data] of pendingEvents) {
			on(type, data);
		}
		pendingEvents = [];
	};
	ws.onclose = () => {
		closeToast = showToast(<>实时同步服务已断开 <button className={"btn primary"} onClick={({target}) => {
			initSync(address);
			closeToast();
		}}>重连</button></>, "error", 0);
	}
	ws.onmessage = async (event) => {
		let {type, data} = JSON.parse(event.data);
		data = await decodeObjects(data);
		switch (type) {
			case "init":
				showToast("实时同步服务已连接, 共 "+data+" 个客户端", "ok");
			break;
			case "conflict":
				SimpleModal({
					title: "其它客户端已经锁定了该对话",
					message: "点击确认关闭其它客户端的对话（可能导致那边未保存的修改丢失）",
					accent: "danger",
					confirmMessage: "强制解锁",
					onConfirm() {
						on("resolve", data);
					},
					onCancel() {
						beginConversation();
					}
				});
			break;
			case "unlock": {
				if (selectedConversation.id === data) {
					forceUnlockId = data;
					prevObj = null;
					conversationMessage = showToast("当前对话已被其它客户端锁定\n您可以尝试重新获取所有权\n或等待对方释放锁", 'error', 0);
					beginConversation();
				}
			}
			break;
			case "released": {
				if (forceUnlockId === data.id) {
					forceUnlockId = -1;
					conversationMessage();
					conversationMessage = null;

					const convList = unconscious(conversations);
					const index = convList.findIndex(item => item.id === data.id);
					const myConv = convList[index];
					if (Object.keys(data).length > 1) {
						for (const key of Object.keys(myConv)) delete myConv[key];
						Object.assign(myConv, data);
					}
					myConv.ready = false;
					selectedConversation.value = myConv;
				}
			}
			break;
			case "update": {
				const index = conversations.findIndex(item => item.id === data.id);
				if (index >= 0) conversations.splice(index, 1);
				if (data.conv) conversations.unshift(await decodeObjects(data.conv));
				else if (selectedConversation.id === data.id) {
					showToast("当前对话已被其它客户端删除", 'error', 0);
					beginConversation();
				}
			}
			break;
		}
	}

	return { on }
}

let prevObj;

onLoad(() => {
	/*$watch(updateConversationListUI, () => {
		on("lock_force", [...runningConversations.keys()]);
	}, false);*/

	$watch(selectedConversation, () => {
		const conv = selectedConversation.value;
		if (conv) {
			prevObj = conv;
			if (!conv.ready) on("lock", prevObj.id);
		} else if (prevObj != null) {
			on("unlock", prevObj);
		}
	});
});
