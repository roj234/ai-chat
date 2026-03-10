import {messages} from "./states.js";
import {debugSymbol, unconscious} from "unconscious";

export const BM = debugSymbol("BranchManager");

/**
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 */
export function convertToBranchMessage(conv, messages) {
	/*conv[BM] = new BranchManager(unconscious(messages));
	conv.branch = true;
	return conv[BM].getMessages();*/
}

/**
 *
 * @param {AiChat.Conversation} conv
 * @return {AiChat.Message[]}
 */
export function convertFromBranchMessage(conv) {
	const bm = conv[BM];
	delete conv.branch;
	delete conv[BM];
	return bm.toArray();
}

export class BranchManager {
	/**
	 *
	 * @param {AiChat.Message[]} allMessages
	 * @param {number} leaf
	 */
	constructor(allMessages, leaf = 0) {
		if (!allMessages[1]?.parent) {
			for (let i = 1; i < allMessages.length; i++){
				const message = allMessages[i];
				message.parent = allMessages[i-1].id;
			}
		}

		// 1. 将数据库读出的平铺数组转为 Map，O(n) 复杂度
		this.messages = new Map(allMessages.map(m => [m.id, m]));

		// 2. 建立父子索引，用于快速查找分支数量 (id -> children_ids[])
		this.children = new Map();
		allMessages.forEach(m => {
			if (m.parent) {
				if (!this.children.has(m.parent)) this.children.set(m.parent, []);
				this.children.get(m.parent).push(m.id);
			}
		});

		// 当前所在的叶子节点 ID
		this.leaf = leaf || this._findDefaultLeaf();
	}

	_findDefaultLeaf() {
		const allIds = Array.from(this.messages.keys());
		const leaves = allIds.filter(id => !this.children.has(id));
		return leaves[leaves.length - 1];
	}

	[Symbol.iterator]() {
		return this.messages.values();
	}

	toArray() {
		const messages = this.getMessages();
		for (const message of messages) {
			delete message.parent;
		}
		return messages;
	}

	/**
	 * 获取当前分支的所有消息 (从叶子向上追溯到根)
	 * 开销极小：只需沿着 parent 向上爬
	 */
	getMessages() {
		const path = [];
		let curr = this.messages.get(this.leaf);
		while (curr) {
			// 倒序的
			path.push(curr);
			curr = this.messages.get(curr.parent);
		}
		return path.reverse();
	}

	/**
	 * 在指定消息处创建新分支
	 * @param {number} parentId 父消息ID
	 * @param {AiChat.Message} message - 消息内容 (已入库，含 id 和 parent = this.leaf)
	 */
	branchAt(parentId, message) {
		const newId = message.id;

		this.messages.set(newId, message);
		if (!this.children.has(parentId)) this.children.set(parentId, []);
		this.children.get(parentId).push(newId);

		this.leaf = newId;
	}

	/**
	 * 切换分支：当某个 ID 有多个子节点时，选择其中一个
	 * @param {number} parentId 分支发生点的 ID
	 * @param {number} index 选择第几个分支
	 */
	switchBranch(parentId, index) {
		let currId = this.children.get(parentId)[index];
		while (true) {
			const children = this.children.get(currId);
			if (!children || children.length === 0) break;
			currId = children[children.length - 1]; // 默认选最新的
		}
		this.leaf = currId;
	}

	/**
	 * 获取对应消息的分支状态
	 * @param {AiChat.Message} message
	 * @returns [当前索引, 总分支数]
	 */
	getBranchInfo(message) {
		const siblings = this.children.get(message.parent);
		return !siblings ? [0, 1] : [siblings.indexOf(message.id), siblings.length];

	}

	/**
	 * 向当前路径末尾追加一条消息
	 * @param {AiChat.Message} message - 消息内容 (已入库，含 id 和 parent = this.leaf)
	 */
	push(message) {
		// 此时 message 已经存入数据库！
		const leaf = this.leaf;
		const id = message.id;

		if (message.parent !== leaf) throw "message.parent !== this.leaf";

		this.messages.set(id, message);

		if (leaf) {
			let children = this.children.get(leaf);
			if (!children) this.children.set(leaf, children = []);
			children.push(id);
		}

		this.leaf = id;
	}

	/**
	 * 删除指定消息及其所有子孙节点，并回退当前叶子 ID 到父节点
	 * @param {number} messageId - 要删除的消息 ID
	 */
	remove(messageId) {
		const msg = this.messages.get(messageId);
		const parentId = msg.parent;

		// 1. 获取所有需要删除的 ID（当前节点及其所有子孙）
		const idsToRemove = [messageId];
		this._removeDescendants(messageId, idsToRemove);

		const siblings = this.children.get(parentId);
		if (siblings) {
			siblings.splice(siblings.indexOf(messageId), 1);
			if (!siblings.length) {
				this.children.delete(parentId);
			}
		}

		this.leaf = parentId || this._findDefaultLeaf();

		// for DB
		return idsToRemove;
	}

	_removeDescendants(id, descendants) {
		this.messages.delete(id);
		const directChildren = this.children.get(id);
		if (directChildren) {
			this.children.delete(id);
			for (const childId of directChildren) {
				descendants.push(childId);
				this._removeDescendants(childId);
			}
		}
	}
}

let bm = new BranchManager([]);

export function setMessages() {

}

export function newBranchFrom(message) {
	bm.branchAt(message.parent, );
}

/**
 *
 * @param {AiChat.Message} message
 * @param {number} branchIndex
 */
export function setBranchIndex(message, branchIndex) {
	//bm.switchBranch(message.parent, branchIndex);
	//messages.value = bm.getMessages();
}

/**
 *
 * @param {AiChat.Message} message
 * @return {[number, number]}
 */
export function getBranchIndexCount(message) {
	//return bm.getBranchInfo(message);
	return [0, 1];
}