import {debugSymbol, unconscious} from "unconscious";
import {showToast} from "../components/Toast.js";
import {messages, selectedConversation} from "../states.js";

export const BM = debugSymbol("BranchManager");

const INDEX = debugSymbol("INDEX");
const CHILDREN = debugSymbol("CHILDREN");
const NO_BRANCHES = [0, 1];

class BranchManager {
	/**
	 * @param {AiChat.Conversation} conv
	 * @param {AiChat.Message[]} messages
	 */
	constructor(conv, messages) {
		// 占位符节点
		messages.unshift({
			id: -1 // 不保存到数据库
		});

		messages.forEach((m, index) => {
			m[INDEX] = index;

			if (index > 0) {
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
		this.conversation = conv;
		this.messages = messages;

		this.leaf = messages[conv.branches] || this._findDefaultLeaf();
		conv.branches = this.leaf[INDEX];
	}

	_findDefaultLeaf() {
		return this.messages.findLast(item => !(item[CHILDREN]?.length));
	}

	toArray() {
		const messages = this.getMessages();
		for (const message of messages) {
			delete message[INDEX];
			delete message[CHILDREN];
			delete message.parent;
		}
		return messages;
	}

	/**
	 * 获取当前分支的所有消息
	 * @return {AiChat.Message[]}
	 */
	getMessages() {
		const path = [];
		let m = this.leaf;
		while (m !== this.messages[0]) {
			path.push(m);
			/*if (m.parent === m[INDEX]) {
				showToast("检测到循环引用", "error");
				console.error("循环引用", m);
				break;
			}*/
			m = this.messages[m.parent];
		}

		const self = this;

		Object.defineProperties(path, {
			push: {
				value: function(...items) {
					for (const item of items) self.branchAt(self.leaf, item);
					return Array.prototype.push.apply(this, items);
				},
				configurable: true
			},
			pop: {
				value: function() {
					const last = this.at(-1);
					if (last) {
						self.remove(last);
						return Array.prototype.pop.apply(this);
					}
				},
				configurable: true
			},
			splice: {
				value: function(start, deleteCount, ...items) {
					if (items.length || start+deleteCount !== this.length)
						throw new Error("无法部分修改分支消息");

					const last = this.at(-deleteCount);
					if (last) {
						const [id, total] = self.getBranchInfo(last);
						self.remove(last);
						if (total > 1) {
							self.switchBranch(self.messages[last.parent], id === 0 ? total - 1 : id - 1);
						}

						const removed = Array.prototype.splice.call(this, start, deleteCount);
						this.length = 0;
						Array.prototype.push.apply(this, self.getMessages());
						return removed;
					}
				},
				configurable: true
			}
		});

		return path.reverse();
	}

	/**
	 * 在指定消息处创建新分支
	 * @param {AiChat.Message} parent 父消息
	 * @param {AiChat.Message} message 子消息
	 */
	branchAt(parent, message) {
		const index = this.messages.length;
		this.messages.push(message);
		message[INDEX] = index;

		message.parent = parent[INDEX];
		if (!parent[CHILDREN]) parent[CHILDREN] = [message];
		else parent[CHILDREN].push(message);

		this.leaf = message;
		this.conversation.branches = index;
	}

	/**
	 * 切换分支：当某个父节点有多个子节点时，选择其中一个
	 * @param {AiChat.Message} parent 分支发生点
	 * @param {number} index 选择第几个分支
	 */
	switchBranch(parent, index) {
		let msg = parent[CHILDREN][index];
		while (true) {
			const child = msg[CHILDREN]?.at(-1);
			if (!child) break;
			msg = child;
		}
		this.leaf = msg;
		//不更新，省的老写数据库
		//this.conversation.branches = msg[INDEX];
	}

	/**
	 * 获取对应消息的分支状态
	 * @param {AiChat.Message} message
	 * @returns {[number, number]} [当前索引, 总分支数]
	 */
	getBranchInfo(message) {
		const siblings = this.messages[message.parent]?.[CHILDREN];
		return !siblings ? NO_BRANCHES : [siblings.indexOf(message), siblings.length];
	}

	/**
	 * 删除指定消息及其所有子孙节点，并回退当前叶子到父节点
	 * @param {AiChat.Message} message - 要删除的消息
	 */
	remove(message) {
		const parent = this.messages[message.parent];
		if (!parent) throw "cannot delete first message";

		const toDelete = new Set();
		const collect = (m) => {
			toDelete.add(m);
			m[CHILDREN]?.forEach(collect);
		};
		collect(message);

		const newMessages = this.messages.filter(m => !toDelete.has(m));

		const idChanges = new Map;
		for (let i = 0; i < newMessages.length; i++) {
			idChanges.set(newMessages[i][INDEX], i);
			newMessages[i][INDEX] = i;
		}
		for (let i = 1; i < newMessages.length; i++) {
			newMessages[i].parent = idChanges.get(newMessages[i].parent);
		}

		this.messages = newMessages;

		const siblings = parent[CHILDREN];
		if (siblings) {
			siblings.splice(siblings.indexOf(message), 1);
			if (!siblings.length) delete parent[CHILDREN];
		}

		this.leaf = parent;
		this.conversation.branches = parent[INDEX];
	}
}

/**
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 */
export function enableBranches(conv, messages) {
	return (conv[BM] = new BranchManager(conv, unconscious(messages))).getMessages();
}

/**
 *
 * @param {AiChat.Conversation} conv
 * @return {AiChat.Message[]}
 */
export function disableBranches(conv) {
	const bm = conv[BM];
	delete conv.branches;
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
	branchManager.leaf = message;
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