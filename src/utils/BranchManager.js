import {debugSymbol, unconscious} from "unconscious";
import {showToast} from "../components/Toast.js";
import {BRANCH_MANAGER, messages as reactiveMessages, selectedConversation} from "../states.js";
import {redoToolCalls, undoToolCalls} from "../toolset.js";

const INDEX = debugSymbol("INDEX");
const CHILDREN = debugSymbol("CHILDREN");
const NO_BRANCHES = [0, 1];

/**
 * 计算父节点下标
 * @param {AiChat.Message} m
 * @returns {number} 父节点下标
 */
const resolveParent = (m) => m[INDEX] - (m.parent ?? 1);

/**
 * 创建分支管理器
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 * @returns {AiChat.BranchManager}
 */
function createBranchManager(conv, messages) {
	messages.unshift({
		id: -1 // 不保存到数据库
	});

	const appendChild = (parent, child) => {
		let children = parent[CHILDREN];
		if (!children) {
			const next = messages[parent[INDEX]+1];
			parent[CHILDREN] = !next || next.parent ? [child] : [next, child];
		} else {
			children.push(child);
		}
	};

	/**
	 * 初始化分支数组：parent现在是相对负数偏移，并且必须大于1
	 * @param {AiChat.Message[]} messages
	 */
	const initBranchArray = (messages) => {
		for (let index = 0; index < messages.length; index++) {
			const m = messages[index];
			m[INDEX] = index;

			const parent = m.parent;
			if (index > 0 && parent) {
				const parentIndex = index - parent;
				const parentMessage = messages[parentIndex];
				if (!parentMessage) {
					showToast(`分支管理器启用失败
找不到 #${index} 的父节点 #${parentIndex}
请尝试编辑原始数据`, "error");
					continue;
				}

				appendChild(parentMessage, m);
			}
		}
	};

	initBranchArray(messages);

	const isLeaf = (m) => {
		const next = messages[m[INDEX]+1];
		return !next || next.parent;
	};

	let leaf = messages[conv.bm_leaf];
	if (!leaf || !isLeaf(leaf)) {
		conv.bm_leaf = (leaf = messages.at(-1))[INDEX];
	}

	/**
	 * 删除/重排后更新 INDEX 并重算受影响的 parent 偏移
	 * @param {AiChat.Message[]} newMessages
	 */
	const _updateIndices = newMessages => {
		const indices = new Map();
		for (let i = 0; i < newMessages.length; i++) indices.set(newMessages[i], i);

		let branchPoints = 0;
		for (let i = 1; i < newMessages.length; i++) {
			const m = newMessages[i];
			if (m.parent != null) {
				const newParentIndex = indices.get(messages[m[INDEX] - m.parent]);
				if (null == newParentIndex) throw new Error('引用已删除的消息 '+i+','+m.parent);

				if (newParentIndex === i - 1) {
					// 删除后父节点恰好变成前一条，隐式化
					delete m.parent;
				} else {
					branchPoints ++;
					m.parent = i - newParentIndex;
				}
			}

			m[INDEX] = i;
		}

		return branchPoints;
	};

	const getMessages = () => {
		const path = [];
		let m = leaf;
		while (m !== messages[0]) {
			path.push(m);
			m = messages[resolveParent(m)];
		}
		return path.reverse();
	};

	const branchAt = (parent, message) => {
		const index = messages.length;
		messages.push(message);
		message[INDEX] = index;

		const parentIndex = parent[INDEX];
		// 只有父节点不是前一条消息时才写 parent
		if (parentIndex !== index - 1) {
			message.parent = index - parentIndex;
			appendChild(parent, message);
		}

		leaf = message;
		conv.bm_leaf = index;
	};

	const switchBranch = (parent, index) => {
		leaf = parent[CHILDREN][index];
		while (1) {
			let next = leaf[CHILDREN]?.at(-1);
			if (!next && isLeaf(leaf)) break;
			leaf = next ?? messages[leaf[INDEX] + 1];
		}
		conv.bm_leaf = leaf[INDEX];
	};

	const getBranchInfo = message => {
		const siblings = messages[resolveParent(message)]?.[CHILDREN];
		return siblings ? [siblings.indexOf(message), siblings.length] : NO_BRANCHES;
	};

	const remove = message => {
		const parent = messages[resolveParent(message)];
		if (!parent) throw "找不到消息 #"+message[INDEX]+" 的 parent";

		const toDelete = new Set();
		const dfs = (m) => {
			let i = m[INDEX];
			for(;;) {
				toDelete.add(m);

				const children = m[CHILDREN];
				if (children) { children.forEach(dfs); break; }

				if (isLeaf(m)) break;

				m = messages[++i];
			}
		};
		dfs(message);

		const newMessages = messages.filter(m => !toDelete.has(m));
		const haveBranches = _updateIndices(newMessages);
		messages = newMessages;

		try {
			const siblings = parent[CHILDREN];
			if (siblings) {
				if (siblings.length <= 2) delete parent[CHILDREN];
				else {
					const idx = siblings.indexOf(message);
					siblings.splice(idx, 1);
					switchBranch(parent, Math.min(idx, siblings.length-1));
					return;
				}
			}

			leaf = parent;
			conv.bm_leaf = parent[INDEX];
		} finally {
			if (!haveBranches) {
				// 没有分支点后禁用分支管理器
				delete conv.bm_leaf;
				delete conv[BRANCH_MANAGER];

				// 不需要删除 [INDEX] 虽然可以删
				const rawMessages = messages.slice(1);
				reactiveMessages.value = rawMessages;
				//updateConversation(conv, rawMessages);
			}
		}
	};

	// ---------- 返回闭包对象 ----------
	return {
		// 感觉没有必要，目前好像没有set
		get messages() { return messages; },
		set messages(m) { messages = m; },

		/**
		 * @param {number} v
		 * @param {boolean=} sync 从原始数据编辑器同步
		 */
		setLeaf(v, sync) {
			leaf = v;
			conv.bm_leaf = leaf[INDEX];
			if (sync) {
				for (let i = 0; i < messages.length; i++) {
					delete messages[i][CHILDREN];
				}
				initBranchArray(messages);
			}
		},
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
				unshift: {
					value(...items) {
						this.splice(0, 0, ...items);
					}
				},
				splice: {
					value(start, deleteCount, ...addItems) {
						if (!deleteCount && !addItems.length) return [];

						const len = path.length;

						start = Number(start) || 0;
						if (start < 0) start = Math.max(len + start, 0);
						else if (start > len) start = len;

						if (deleteCount === undefined) deleteCount = len - start;
						else deleteCount = Math.max(0, deleteCount | 0);

						if (deleteCount) {
							if (start + deleteCount !== this.length)
								throw new Error("无法部分修改分支消息");
							if (addItems.some(item => item.id > 0))
								throw new Error("不能加入已入库的消息");

							const last = path.at(-deleteCount);
							if (last) {
								remove(last);
								this.push(...addItems);
							}
						} else {
							if (!addItems.every(item => item.id < 0))
								throw new Error("只能在开头插入虚拟（不入库）消息");

							for (let i = 0; i < path.length; i++) {
								if (path[i][CHILDREN]) {
									if (start > i) {
										throw new Error("虚拟消息只能插入在第一个分支点前");
									}
									break;
								}
							}

							const copy = [...messages];
							copy.splice(start + 1, 0, ...addItems);
							_updateIndices(copy);

							if (start === path.length) leaf = addItems.at(-1);
							messages = copy;
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
		hasBranch(message) {
			let i = message[INDEX];
			while (true) {
				if (message?.[CHILDREN]) return true;
				if (isLeaf(message)) return false;
				message = messages[++i];
			}
		}
	};
}

/**
 * 为会话启用分支管理器，初始化消息树结构并返回当前分支的消息路径。
 * 包含旧版 parent 格式的自动迁移逻辑。
 * @param {AiChat.Conversation} conv - 会话对象，会在其上挂载 BRANCH_MANAGER
 * @param {AiChat.Message[]} messages - 原始消息数组
 * @returns {AiChat.Message[]} 当前分支的消息路径（带有 hook 的数组）
 */
export function enableBranches(conv, messages) {
	const msg = unconscious(messages);

	// migration
	if (msg[0]?.parent === 0) {
		for (let i = 0; i < msg.length; i++) {
			const m = msg[i];
			const oldParent = m.parent;
			// 注意有隐式的message #0 所以这里+1了
			if (oldParent === i) {
				delete m.parent;
			} else {
				m.parent = i - oldParent + 1;
			}
		}
	}

	const bm = createBranchManager(conv, msg);
	conv[BRANCH_MANAGER] = bm;
	return bm.getMessages();
}

/**
 * 深拷贝一条消息，同时保留其在分支管理器中的 INDEX 符号属性。
 * @param {AiChat.Message} message - 要克隆的消息
 * @returns {AiChat.Message} 克隆后的消息副本
 */
export const cloneMessage = (message) => {
	const cloned = structuredClone(message);
	cloned[INDEX] = message[INDEX];
	return cloned;
}

/**
 * 在指定消息的父节点处创建一个副本分支（复制该消息并作为新分支挂到同一父节点下）。
 * @param {AiChat.Message} message - 要复制的消息
 */
export const copyBranchAt = message => {
	const global = unconscious(selectedConversation);
	/** @type {AiChat.BranchManager} */
	const bm = global[BRANCH_MANAGER];
	bm.branchAt(bm.messages[resolveParent(message)], message);
	setMessages(bm.getMessages(), global);
};

/**
 * 检查从指定消息开始（含自身）到叶子节点的路径上是否存在分支点。
 * 用于删除操作前判断后续消息是否包含分支，以决定是否弹出警告。
 * @param {AiChat.Message} message - 要检查的起始消息
 * @returns {boolean} 如果从该消息到叶子的路径上存在分支点则返回 true
 */
export const hasBranchAfter = (message) => {
	const global = unconscious(selectedConversation);
	/** @type {AiChat.BranchManager} */
	const bm = global[BRANCH_MANAGER];
	return message && bm.hasBranch(message);
}

/**
 * 将这条消息设置为最后一条消息
 * @param {AiChat.Message} message
 */
export const setLastMessage = message => {
	const global = unconscious(selectedConversation);
	/** @type {AiChat.BranchManager} */
	const bm = global[BRANCH_MANAGER];
	bm.setLeaf(message);
	setMessages(bm.getMessages(), global);
};


const setMessages = (newMessages, global) => {
	const oldMessages = unconscious(reactiveMessages);
	reactiveMessages.value = newMessages;

	let prefix = 0;
	for (; prefix < Math.min(oldMessages.length, newMessages.length); prefix++) {
		if (oldMessages[prefix] !== newMessages[prefix]) break;
	}
	undoToolCalls(global, oldMessages, prefix, true);
	redoToolCalls(global, newMessages, prefix, true);
};

/**
 * 切换到指定消息所在父节点的某个分支，并更新消息路径。
 * @param {AiChat.Message} message - 目标分支中的消息
 * @param {number} branchIndex - 要切换到的分支下标（在 CHILDREN 数组中的索引）
 */
export const setBranchIndex = (message, branchIndex) => {
	const global = unconscious(selectedConversation);
	/** @type {AiChat.BranchManager} */
	const bm = global[BRANCH_MANAGER];
	bm.switchBranch(bm.messages[resolveParent(message)], branchIndex);
	setMessages(bm.getMessages(), global);
};

/**
 * 获取指定消息在其父节点下的分支信息：当前分支下标和分支总数。
 * 如果没有分支管理器则返回 [0, 1]。
 * @param {AiChat.Message} message - 要查询的消息
 * @returns {[number, number]} [当前分支索引, 分支总数]
 */
export const getBranchIndexCount = message => selectedConversation[BRANCH_MANAGER]?.getBranchInfo(message) || NO_BRANCHES;
