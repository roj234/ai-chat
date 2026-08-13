import {sendToSyncServer} from "/src/database/remoteSync.js";
import {SYNC_RPC, SYNC_SEND_TO_OWNER} from "/backend/sync_const.js";
import {config, conversations, inputText, selectedConversation, switchToConversation} from "/src/states.js";
import {$cleanup, $state, $update, $watch, unconscious} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import {DI, onLoad} from "/src/hooks.js";
import {delta, patch, rep} from "unconscious/common/deepEqual.js";
import {prettyError} from "/src/utils/utils.js";

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
		clientState.value = { title: "请稍候" };

		const pendingRPC = $state(true);
		const serialRPC = (...args) => {
			pendingRPC.value = true;
			const promise = RPC(...args);
			promise.catch(err => {
				showToast("函数调用失败:\n" + prettyError(err), 'error', 0);
			}).finally(() => pendingRPC.value = false);
			return promise;
		}

		RPC(id, SUBSCRIBE).then(onReceiveStateUpdate, () => div.remove()).finally(() => pendingRPC.value = false);

		const div = (<div>
			<div className="filter-row">
				<div className="filter-label">远程控制</div>
				<div className="input-warp">
						<textarea className="text-input" placeholder="草泥马，不是这样写的"
							disabled={pendingRPC} value={() => clientState.text}
							onInput={({target}) => {
								sendToSyncServer(SYNC_SEND_TO_OWNER, [id, [INPUT, 0, delta(clientState.text, target.value)]]);
							}}
						></textarea>
				</div>
			</div>
			<div className="filter-row">
				<div className="choice-scroll">
					<div className={"spacer"}></div>
					<button
						disabled={() => unconscious(pendingRPC) || clientState.disabled != null}
						title={() => clientState.title}
						className={() => clientState.class}
						onClick={() => serialRPC(id, SUBMIT)}
					>
						{() => clientState.title}
					</button>
				</div>
			</div>
			<div className="filter-row">
				<div className="filter-label">切换到对话</div>
				<div className="input-warp">
					<input className="text-input" type="number" placeholder="对话ID"
						disabled={pendingRPC} value={() => clientState.convId}
						onChange={({target}) => {
							if (!target.value) return;
							serialRPC(id, SWITCH_TO, target.valueAsNumber);
						}}
					/>
				</div>
			</div>
		</div>);

		// 清理时取消订阅
		$cleanup(div, () => {
			sendToSyncServer(SYNC_SEND_TO_OWNER, [id, [UNSUBSCRIBE]]);
		});

		return div;
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
				showToast(`找不到该对话的写入锁持有者`, 'error');
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
		if (config.afkState < 2) {
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
	DI.RMI = RMI;
	onLoad((app) => {
		sendBtn = app.querySelector(".composer .controls > button");

		new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				immediateState[mutation.attributeName] = sendBtn.getAttribute(mutation.attributeName);
			}
			onStateUpdated();
		}).observe(sendBtn, { attributes: true, });

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