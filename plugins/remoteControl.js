import {sendToSyncServer} from "/src/database/syncClient.js";
import {SYNC_RPC, SYNC_SEND_TO_OWNER} from "/backend/sync.js";
import {config, conversations, inputText, isMobile, selectedConversation, switchToConversation} from "/src/states.js";
import {$state, $update, $watch, unconscious} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import {DI, onLoad} from "/src/hooks.js";
import {delta, patch, rep} from "unconscious/common/deepEqual.js";
import {prettyError} from "/src/utils/utils.js";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {SETTINGS} from "../src/settings.js";
import {ContextRing} from "../src/components/SendButton.jsx";

// 消息类型常量
const NO_SUCH_CLIENT = -1;
const NO_SUCH_LOCK_OWNER = -2;
const RPC_CALLBACK = 0;
const STATE_UPDATE = 1;
const SUBSCRIBE = 2;
const UNSUBSCRIBE = 3;
const INPUT = 4;
const SUBMIT = 5;
const SWITCH_TO = 6;

// RPC 调用管理
let rpcId;
const rpcTasks = new Map;
const RPC = (conversationId, func, payload) => new Promise((resolve, reject) => {
	rpcTasks.set(rpcId, [resolve, reject]);
	sendToSyncServer(SYNC_SEND_TO_OWNER, [
		conversationId,
		[func, rpcId, payload],
	]);
	rpcId++;
});

/**
 * @typedef {Object} RPCState
 * @property {string} title
 * @property {string} class
 * @property {''|null} disabled
 * @property {string} text
 * @property {number} convId
 * @property {boolean} running
 */

// ---------- 被控端（服务端） ----------

/** @type {HTMLElement} */
let sendBtn;

/** @type {Set<string>} */
const subscriptions = new Set();

/** @type {RPCState} */
let cachedState = {}, immediateState = {};

/** 向所有订阅了某对话的客户端推送当前状态 */
const onStateUpdated = () => {
	if (!subscriptions.size) return;

	const diff = delta(cachedState, immediateState);
	if (diff === undefined) return;
	cachedState = patch(cachedState, diff);

	subscriptions.forEach((clientId) => {
		sendToSyncServer(SYNC_RPC, [clientId, [STATE_UPDATE, 0, diff]]);
	});
};

// ---------- 控制端（客户端） ----------

/** @type {HTMLElement} */
let composer;

/** @type {import("unconscious").Reactive<RPCState>} */
const clientState = $state();

/** 控制端收到 STATE_UPDATE 后更新 UI */
const onReceiveStateUpdate = diff => {
	clientState.value = patch(unconscious(clientState), diff);
	$update(clientState);
};

// ---------- remoteMethodInvocation ----------

const RMI = {
	/**
	 * @param {string[]} clients
	 * @param {string} clientId
	 */
	open(clients, clientId) {
		rpcId = 1;
	},
	close() {
		for (const [_, reject] of rpcTasks.values()) {
			reject("连接已关闭");
		}
		rpcTasks.clear();
		subscriptions.clear();
	},

	/**
	 * 控制端调用：创建一个远程控制面板
	 * @param {number} id - 被控对话的 conversationId
	 */
	render(id) {
		clientState.value = {};

		const rpcBusy = $state(true);
		const serialRPC = (...args) => {
			rpcBusy.value = true;
			const promise = RPC(id, ...args);
			promise.catch(err => {
				showToast("函数调用失败:\n" + prettyError(err), 'error', 0);
			}).finally(() => rpcBusy.value = false);
			return promise;
		}

		const fakeInputBox = <textarea
			placeholder="有事尽管问我"
			disabled={rpcBusy} value={() => clientState.text}
			onInput={() => {
				sendToSyncServer(SYNC_SEND_TO_OWNER, [id, [INPUT, 0, delta(clientState.text, fakeInputBox.value)]]);
			}}
			onKeyDown={(e) => {
				if (isMobile) return;
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					e.stopImmediatePropagation();
					fakeSendButton.click();
				}
			}}
		/>;
		const fakeSendButton = <button
			disabled={() => clientState.disabled != null || unconscious(rpcBusy)}
			title={() => clientState.title}
			className={() => clientState.class}
			onClick={() => serialRPC(SUBMIT)}
		/>;

		const vl = new VirtualList({
			data: unconscious(conversations).filter(conv => conv.id > 0),
			renderer: data => <li
				className={"ellipsis" + (data === unconscious(selectedConversation) ? " selected" : "")}
				_conv={data} title={data.title}>{data.title || "#" + data.id}</li>
		});

		const changeConversation = <div className="pretty-select preset-switch up">
			<div className="input" onClick.stop={() => changeConversation.classList.toggle("open")}>切换远程会话<span
				className="arrow-icon ri-arrow-down-s-line"></span></div>
			<ul className="dropdown" style={"width:250px"} onClick.delegate{"li"}={e => {
				if (unconscious(rpcBusy)) return;
				const conv = e.delegateTarget._conv;
				serialRPC(SWITCH_TO, conv.id).then(() => switchToConversation(conv));
			}}>
				{vl.dom}
			</ul>
		</div>;
		vl.attach(changeConversation.querySelector(".dropdown"));

		const fakeQuery = <div className="query rc">
			{fakeInputBox}
			<div className="controls">
				<div>{changeConversation}</div>
				<div className="spacer"></div>
				{ContextRing(fakeSendButton)}
			</div>
		</div>;

		let fail;
		RPC(id, SUBSCRIBE).then(diff => {
			onReceiveStateUpdate(diff);
			rpcBusy.value = false;
			composer.append(fakeQuery);
		}, () => {
			fail = true;
			showToast("远端未启用远程控制", "error");
		});

		// 清理时取消订阅
		return () => {
			if (fail) return;
			sendToSyncServer(SYNC_SEND_TO_OWNER, [id, [UNSUBSCRIBE]]);
			fakeQuery.remove();
		};
	},

	/**
	 * 被控端通知状态变化（由外部调用）
	 * @param {number} id - 对话ID
	 * @param {boolean} running - 当前运行状态（兼容旧接口，可忽略）
	 */
	state(id, running) {
		if (id === selectedConversation.id) {
			immediateState.running = !!running;
			onStateUpdated();
		}
	},

	/**
	 * 消息处理（客户端、服务端共用）
	 * @param {string} sender
	 * @param {number} func
	 * @param {number|undefined} rpcId
	 * @param {any} payload
	 */
	handle([sender, [func, rpcId, payload]]) {
		if (func === RPC_CALLBACK) {
			const callback = rpcTasks.get(rpcId);
			if (callback) {
				rpcTasks.delete(rpcId);
				if (typeof payload === "object" && "error" in payload) {
					callback[1](payload.error);
				} else {
					callback[0](payload);
				}
			}
			return;
		}

		// 同步服务错误
		if (func < 0) {
			if (func === NO_SUCH_CLIENT) {
				subscriptions.delete(sender);
				return;
			}
			if (func === NO_SUCH_LOCK_OWNER) {
				console.warn(`找不到该对话的写入锁持有者`, payload);
				return;
			}
			return;
		}

		// 控制端
		if (func === STATE_UPDATE) {
			onReceiveStateUpdate(payload);
			return;
		}

		const reply = (response) => rpcId && sendToSyncServer(SYNC_RPC, [sender, [RPC_CALLBACK, rpcId, response]]);

		// 被控端
		if (!config.remoteControl) {
			reply({ error: "未启用远程控制" });
			return;
		}

		switch (func) {
			case SUBSCRIBE:
				subscriptions.add(sender);
				reply(rep(immediateState));
				return;
			case UNSUBSCRIBE:
				subscriptions.delete(sender);
				break;
			case INPUT:
				inputText.value = patch(unconscious(inputText), payload);
				break;
			case SUBMIT:
				sendBtn.click();
				break;
			case SWITCH_TO:
				const conv = conversations.find(item => item.id === payload);
				if (!conv) {
					reply({ error: '找不到对话 #'+payload })
					return;
				}
				switchToConversation(conv);
				break;

			default:
				reply({ error: "未知操作" });
				return;
		}
		reply("OK");
	},
};

export const registerRemoteControl = () => {
	SETTINGS.push({
		id: "remoteControl",
		//_tab: "tools",
		name: "远程操作",
		type: "radio",
		required: true,
		choices: {
			"拒绝": false,
			"允许": true,
		},
	});

	DI.RMI = RMI;
	onLoad((app) => {
		sendBtn = DI.sendButton;
		composer = sendBtn.closest(".composer");

		// server
		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				immediateState[mutation.attributeName] = sendBtn.getAttribute(mutation.attributeName);
			}
			onStateUpdated();
		}).observe(sendBtn, {attributes: true,});

		$watch(inputText, () => {
			immediateState.text = unconscious(inputText);
			onStateUpdated();
		});

		$watch(selectedConversation, () => {
			immediateState.convId = selectedConversation.id;
			onStateUpdated();
		})
	});
}