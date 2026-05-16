import {debugSymbol, unconscious} from "unconscious";
import {showToast} from "../components/Toast.js";
import {messages, selectedConversation} from "../states.js";

export const BM = debugSymbol("BranchManager");

const INDEX = debugSymbol("INDEX");
const CHILDREN = debugSymbol("CHILDREN");
const NO_BRANCHES = [0, 1];

/**
 * 创建分支管理器
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 * @returns {AiChat.BranchManager}
 */
function createBranchManager(conv, messages) {
	// ---------- 构造阶段 ----------
	messages.unshift({
		id: -1 // 不保存到数据库
	});

	if (conv.bm_dummy) {
		for (const id of conv.bm_dummy) {
			messages.splice(id, 0, { id: -1, hidden: true });
		}
	}

	const dynamic = [];
	messages.forEach((m, index) => {
		m[INDEX] = index;

		if (index > 0) {
			if (m.id === -1) dynamic.push(index);

			let {parent} = m;
			if (null == parent) m.parent = parent = index - 1;

			const parentMessage = messages[parent];
			if (!parentMessage) {
				showToast(`分支对话参数错误
找不到子节点 #${index} 引用的父节点 #${parent}`, "error");
				return;
			}

			let children = parentMessage[CHILDREN];
			if (!children) parentMessage[CHILDREN] = [m];
			else children.push(m);
		}
	});

	if (dynamic.length) conv.bm_dummy = dynamic;

	const findDefaultLeaf = () => messages.findLast(item => !(item[CHILDREN]?.length));

	const leafMessage = messages[conv.bm_leaf];
	let leaf = leafMessage && !leafMessage[CHILDREN]?.length ? leafMessage : findDefaultLeaf();
	conv.bm_leaf = leaf[INDEX];

	// ---------- 私有辅助函数 ----------
	const _updateIndices = newMessages => {
		const idChanges = new Map();
		for (let i = 0; i < newMessages.length; i++) {
			idChanges.set(newMessages[i][INDEX], i);
			newMessages[i][INDEX] = i;
		}
		for (let i = 1; i < newMessages.length; i++) {
			newMessages[i].parent = idChanges.get(newMessages[i].parent);
		}
	};

	// ---------- 公开方法 ----------
	const toArray = () => {
		const msgs = getMessages();
		for (const message of msgs) {
			delete message[INDEX];
			delete message[CHILDREN];
			delete message.parent;
		}
		return msgs;
	};

	const getMessages = () => {
		const path = [];
		let m = leaf;
		while (m !== messages[0]) {
			path.push(m);

			let {parent} = m;
			// 正常情况下是不会出现的，但是如果有人动原始的消息数组
			if (import.meta.env.DEV && parent === m[INDEX]) {
				path.length = 0;
				Array.prototype.push.apply(path, messages.slice(1).reverse());
				break;
			}
			m = messages[parent];
		}

		return path.reverse();
	};

	const branchAt = (parent, message) => {
		const index = messages.length;
		messages.push(message);
		message[INDEX] = index;

		message.parent = parent[INDEX];
		if (!parent[CHILDREN]) parent[CHILDREN] = [message];
		else parent[CHILDREN].push(message);

		leaf = message;
		conv.bm_leaf = index;
	};

	const switchBranch = (parent, index) => {
		let msg = parent[CHILDREN][index];
		while (true) {
			const child = msg[CHILDREN]?.at(-1);
			if (!child) break;
			msg = child;
		}
		leaf = msg;
		conv.bm_leaf = msg[INDEX];
	};

	const getBranchInfo = message => {
		const siblings = messages[message.parent]?.[CHILDREN];
		return !siblings ? NO_BRANCHES : [siblings.indexOf(message), siblings.length];
	};

	const remove = message => {
		const parent = messages[message.parent];
		if (!parent) throw "cannot delete first message";

		const toDelete = new Set();
		const collect = (m) => {
			toDelete.add(m);
			m[CHILDREN]?.forEach(collect);
		};
		collect(message);

		const newMessages = messages.filter(m => !toDelete.has(m));
		_updateIndices(newMessages);
		messages = newMessages;

		const siblings = parent[CHILDREN];
		if (siblings) {
			siblings.splice(siblings.indexOf(message), 1);
			if (!siblings.length) delete parent[CHILDREN];
		}

		leaf = parent;
		conv.bm_leaf = parent[INDEX];
	};

	// ---------- 返回闭包对象 ----------
	return {
		get messages() { return messages; },
		setLeaf(v) { leaf = v; },
		getMessages() {
			const path = getMessages();
			Object.defineProperties(path, {
				push: {
					value(...items) {
						for (const item of items) branchAt(leaf, item);
						return Array.prototype.push.apply(path, items);
					},
					configurable: true
				},
				pop: {
					value() {
						const last = path.at(-1);
						if (last) {
							remove(last);
							return Array.prototype.pop.apply(path);
						}
					},
					configurable: true
				},
				splice: {
					value(start, deleteCount, ...addItems) {
						if (deleteCount) {
							if (start + deleteCount !== this.length)
								throw new Error("无法部分修改分支消息");

							const last = path.at(-deleteCount);
							if (last) {
								const [id, total] = getBranchInfo(last);
								remove(last);
								if (total > 1) {
									switchBranch(messages[last.parent], id === 0 ? total - 2 : id - 1);
								}
								this.push(...addItems);
							}
						} else {
							const allMessages = messages;
							for (let i = 0; i < addItems.length; i++) {
								const prev = allMessages[i + start + 1];
								if (prev.role) throw new Error("无法部分修改分支消息");

								const curr = addItems[i];
								for (const key of [CHILDREN, INDEX, "parent"]) {
									curr[key] = prev[key];
								}
								allMessages[i + start + 1] = curr;
							}
						}

						const removed = Array.prototype.splice.call(path, start, deleteCount);
						path.length = 0;
						Array.prototype.push.apply(path, getMessages());
						return removed;
					},
					configurable: true
				}
			});
			return path;
		},
		branchAt,
		switchBranch,
		getBranchInfo,
		remove,
		toArray
	};
}

/**
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 */
export function enableBranches(conv, messages) {
	const bm = createBranchManager(conv, unconscious(messages));
	conv[BM] = bm;
	return bm.getMessages();
}

/**
 *
 * @param {AiChat.Conversation} conv
 * @return {AiChat.Message[]}
 */
export function disableBranches(conv) {
	const bm = conv[BM];
	delete conv.bm_leaf;
	delete conv.bm_dummy;
	delete conv[BM];
	return bm.toArray();
}


/**
 * @param {AiChat.Message} message
 */
export function copyBranchAt(message) {
	/** @type {AiChat.BranchManager} */
	const branchManager = selectedConversation[BM];
	const copiedMessage = structuredClone(message);
	copiedMessage.id = -1;
	branchManager.branchAt(branchManager.messages[message.parent], copiedMessage);
	messages.value = branchManager.getMessages();
	return copiedMessage;
}

/**
 * 将这条消息设置为最后一条消息
 * @param {AiChat.Message} message
 */
export function setLastMessage(message) {
	/** @type {AiChat.BranchManager} */
	const branchManager = selectedConversation[BM];
	branchManager.setLeaf(message);
	messages.value = branchManager.getMessages();
}


/**
 *
 * @param {AiChat.Message} message
 * @param {number} branchIndex
 */
export function setBranchIndex(message, branchIndex) {
	/** @type {AiChat.BranchManager} */
	const bm = selectedConversation[BM];
	bm.switchBranch(bm.messages[message.parent], branchIndex);
	messages.value = bm.getMessages();
}

/**
 *
 * @param {AiChat.Message} message
 * @return {[number, number]}
 */
export function getBranchIndexCount(message) {
	return selectedConversation[BM]?.getBranchInfo(message) || NO_BRANCHES;
}