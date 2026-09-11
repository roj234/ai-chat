import {debugSymbol, unconscious} from "unconscious";
import {showToast} from "../components/Toast.js";
import {BRANCH_MANAGER, EVENT_BUS, messages as reactiveMessages} from "../states.js";
import {redoToolCalls, undoToolCalls} from "../toolset.js";
import {FSE_NotAllowed, FSE_NotFound, throwDOMException} from "/common/pure-utils.js";
import {getImmediateMessages, markMessageDirty} from "../database.js";
import {getRandomString} from "./utils.js";

const INDEX = debugSymbol("INDEX");
const CHILDREN = debugSymbol("CHILDREN");
const FOLDED_MESSAGES = debugSymbol("FoldedMessages");

/**
 * 计算父节点下标
 * @param {AiChat.Message} m
 * @returns {number} 父节点下标
 */
const resolveParent = (m) => m[INDEX] - (m.parent ?? 1);

const DESTROYED_MESSAGE_SHOULD_NOT_HAPPEN = "Branch manager was destroyed";
const NOT_ALLOWED = () => throwDOMException("BranchManager array", FSE_NotAllowed);

/**
 * 创建分支管理器
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 * @returns {AiChat.BranchManager}
 */
function createBranchManager(conv, messages) {
	const SENTRY = {
		id: -1 // 不保存到数据库
	};
	messages.unshift(SENTRY);

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
	 * @param {boolean} [init]
	 */
	const initBranchArray = (messages, init) => {
		if (!init)
			for (const m of messages) delete m[CHILDREN];

		for (let index = 0; index < messages.length; index++) {
			const m = messages[index];
			m[INDEX] = index;

			const parent = m.parent;
			if (index > 0 && parent != null) {
				const parentIndex = index - parent;
				const parentMessage = messages[parentIndex];
				if (parent <= 0 || !parentMessage) {
					showToast(`分支管理器启用失败
找不到 #${index} 的父节点 #${parentIndex}
请尝试编辑原始数据`, "error");
					delete m.parent;
					continue;
				}

				appendChild(parentMessage, m);
			}
		}
	};

	initBranchArray(messages, true);

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
	 * @param {AiChat.Message[]} oldIndices
	 */
	const _updateIndices = (oldIndices) => {
		const indices = new Map();
		for (let i = 0; i < messages.length; i++) indices.set(messages[i], i);

		let inUse = 0;
		for (let i = 1; i < messages.length; i++) {
			const m = messages[i];
			const parent = m.parent;
			if (parent != null) {
				const newParentIndex = indices.get(oldIndices[m[INDEX] - parent]);
				if (null == newParentIndex) throwDOMException('引用已删除的消息 '+i+','+parent);

				if (newParentIndex === i - 1) {
					// 删除后父节点恰好变成前一条，隐式化
					delete m.parent;
				} else {
					inUse++;
					m.parent = i - newParentIndex;
				}

				if (parent !== (m.parent ?? 1))
					markMessageDirty(m);
			}

			if (m.foldGroup != null) inUse++;

			m[INDEX] = i;
		}

 		conv.bm_leaf = leaf[INDEX];
		return inUse;
	};

	// 禁用分支管理器
	const deactivate = () => {
		delete conv.bm_leaf;
		delete messages[BRANCH_MANAGER];
		if (import.meta.env.DEV)
			delete conv[BRANCH_MANAGER];
		path.length = 0;

		// 不需要删除 [INDEX] 虽然可以删
		messages.shift();
		if (unconscious(reactiveMessages) === path)
			reactiveMessages.value = messages;
	};

	const push_ = Array.prototype.push;
	const updatePath = () => {
		if (messages[0] !== SENTRY) throwDOMException(DESTROYED_MESSAGE_SHOULD_NOT_HAPPEN, "InvalidStateError");
		path.length = 0;

		let currentFoldGroup;
		let m = leaf;

		while (true) {
			const activeGroup = m.foldGroup?.at(-1);
			if (activeGroup !== currentFoldGroup?.group) {
				if (currentFoldGroup != null) {
					currentFoldGroup[FOLDED_MESSAGES].reverse();
					currentFoldGroup = null;
				}
				if (activeGroup != null) {
					const myMessage = m;
					const payload = m.folded?.at(-1);
					currentFoldGroup = {
						...payload,
						role: "fold",
						group: activeGroup,
						end: myMessage[INDEX],
						[FOLDED_MESSAGES]: []
					};
					push_.call(path, new Proxy(currentFoldGroup, {
						set(target, p, newValue) {
							if (p === 'role' || p === 'group' || p === 'end' || p === 'start') {
								return false;
							}

							target[p] = payload[p] = newValue;
							return true;
						},
						deleteProperty(target, p) {
							// 这叫：一个bug是bug，两个bug能work（
							// 先这样用着吧
							markMessageDirty(myMessage);

							delete target[p];
							delete payload[p];
							return true;
						}
					}));
				}
			}

			if (m === messages[0]) break;

			if (currentFoldGroup == null) push_.call(path, m);
			else {
				currentFoldGroup.start = m[INDEX];
				currentFoldGroup[FOLDED_MESSAGES].push(m);
			}

			if (import.meta.env.DEV && path.length > 5000)
				debugger;

			m = messages[resolveParent(m)];
		}
		Array.prototype.reverse.call(path);
		//path.reverse();
	};

	/**
	 * @param {AiChat.Message} parent
	 * @param {AiChat.Message} message
	 */
	const branchAt = (parent, message) => {
		if (parent.role === 'fold') parent = messages[parent.end];

		const index = messages.length;
		messages.push(message);
		message[INDEX] = index;

		if (message.parent != null) {
			// 同步用
			parent = messages[resolveParent(message)];
			appendChild(parent, message);
		} else {
			const parentIndex = parent[INDEX];
			// 只有父节点不是前一条消息时才写 parent
			if (parentIndex !== index - 1) {
				message.parent = index - parentIndex;
				appendChild(parent, message);
			}
		}


		leaf = message;
		conv.bm_leaf = index;
	};

	/**
	 * 切换到指定消息所在父节点的某个分支，并更新消息路径。
	 * @param {AiChat.Message} parent - 目标分支中的消息
	 * @param {number} index - 要切换到的分支下标（在 CHILDREN 数组中的索引）
	 */
	const switchBranch = (parent, index) => {
		leaf = parent[CHILDREN][index];
		while (1) {
			let next = leaf[CHILDREN]?.at(-1);
			if (!next && isLeaf(leaf)) break;
			leaf = next ?? messages[leaf[INDEX] + 1];
		}
		conv.bm_leaf = leaf[INDEX];
	};

	/**
	 * @param {AiChat.Message} from
	 * @param {AiChat.Message} [to]
	 */
	const remove = (from, to) => {
		if (from.role === 'fold') from = messages[from.start];
		if (to?.role === 'fold') to = messages[to.start];

		const parent = messages[resolveParent(from)];
		if (!parent) throwDOMException("找不到消息 #"+from[INDEX]+" 的 parent", FSE_NotFound);

		const toDelete = new Set();
		const dfs = (m) => {
			let i = m[INDEX];
			for(;;) {
				if (m === to) break;
				toDelete.add(m);

				const children = m[CHILDREN];
				if (children) { children.forEach(dfs); break; }

				if (isLeaf(m)) break;

				m = messages[++i];
			}
		};
		dfs(from);

		if (to != null) {
			to.parent = to[INDEX] - parent[INDEX];
		}

		const bak = [...messages];

		let j = 0;
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (toDelete.has(m)) continue;
			messages[j++] = m;
		}
		messages.length = j;
		const inUse = _updateIndices(bak);

		if (to != null) {
			if (!inUse) deactivate();
			else initBranchArray(messages);
			return;
		}

		try {
			const siblings = parent[CHILDREN];
			if (siblings) {
				const idx = siblings.indexOf(from);
				siblings.splice(idx, 1);

				const length = siblings.length;
				if (length) {
					switchBranch(parent, Math.min(idx, length-1));

					if (length === 1 && siblings[0][INDEX] === parent[INDEX]+1) {
						delete parent[CHILDREN];
					}
					return true;
				}

				delete parent[CHILDREN];
			}

			leaf = parent;
			conv.bm_leaf = parent[INDEX];
		} finally {
			if (!inUse) deactivate();
		}
	};

	const path = [];

	const proto = {
		get owner() { return conv; },
		get raw() { return messages; },
		setLeaf(leaf1) {
			leaf = leaf1;
			conv.bm_leaf = leaf[INDEX];
			updatePath();
		},

		// 不允许的数组修改函数
		sort: NOT_ALLOWED,
		reverse: NOT_ALLOWED,
		fill: NOT_ALLOWED,
		copyWithin: NOT_ALLOWED,
		//region 即时反应的原生数组方法hook
		push(...items) {
			for (const item of items) branchAt(leaf, item);
			return push_.apply(path, items);
		},
		pop() {
			const last = path.at(-1);
			if (last) {
				if (remove(last)) {
					updatePath();
				} else {
					Array.prototype.pop.apply(path);
				}
				return last;
			}
		},
		unshift(...items) {
			proto.splice(0, 0, ...items);
			return path.length;
		},
		shift() {
			return path.splice(0, 1)[0];
		},
		/**
		 *
		 * @param {number} start
		 * @param {number} [deleteCount]
		 * @param {AiChat.Message[]} [addItems]
		 * @return {AiChat.Message[]}
		 */
		splice(start, deleteCount, ...addItems) {
			if (!deleteCount && !addItems.length) return [];
			if (messages[0] !== SENTRY) throwDOMException(DESTROYED_MESSAGE_SHOULD_NOT_HAPPEN, "InvalidStateError");

			const len = path.length;

			start = Number(start) || 0;
			if (start < 0) start = Math.max(len + start, 0);
			else if (start > len) start = len;

			if (deleteCount === undefined) deleteCount = len - start;
			else deleteCount = Math.min(len - start, Math.max(0, deleteCount | 0));

			block:
			if (deleteCount) {
				if (addItems.some(item => item.id > 0))
					throwDOMException("不能加入已入库的消息", FSE_NotAllowed);

				if (start + deleteCount !== path.length) {
					if (path.slice(start, start + deleteCount).every(item => item.id < 0)) {
						const bak = [...messages];
						messages.splice(path[start][INDEX], deleteCount, ...addItems);
						_updateIndices(bak);
					} else {
						if (addItems.length)
							throwDOMException("不能在数组中间插入消息", FSE_NotAllowed);
						remove(path.at(start), path.at(start + deleteCount));
					}

					break block;
				}

				const last = path.at(-deleteCount);
				if (last) {
					remove(last);
					if (messages[0] === SENTRY) proto.push(...addItems);
					else messages.push(...addItems);
				}
			} else {
				if (!addItems.every(item => item.id < 0))
					throwDOMException("只能在开头插入虚拟（不入库）消息", FSE_NotAllowed);

				for (let i = 0; i < path.length; i++) {
					if (path[i][CHILDREN]) {
						if (start > i) {
							throwDOMException("虚拟消息只能插入在第一个分支点前", FSE_NotAllowed);
						}
						break;
					}
				}

				const at = path[start];
				const rawIndex = at ? (at.role === 'fold' ? at.start : at[INDEX]) : messages.length;

				const bak = [...messages];
				messages.splice(rawIndex, 0, ...addItems);
				_updateIndices(bak);
			}

			const removed = Array.prototype.splice.call(path, start, deleteCount);
			if (messages[0] === SENTRY) updatePath();
			return removed;
		},
		//endregion

		branchAt(parent, message) {
			branchAt(parent, message);
			updatePath();
		},
		switchBranch(parent, index) {
			switchBranch(parent, index);
			updatePath();
		},
		parentOf(message) {
			return messages[resolveParent(message)]
		},
		/**
		 * @param {AiChat.Message} message
		 */
		getBranchInfo: message => {
			const siblings = messages[resolveParent(message)]?.[CHILDREN];
			return siblings && [siblings.indexOf(message), siblings.length];
		},
		/**
         * 检查从指定消息开始（含自身）到叶子节点的路径上是否存在分支点（未使用）。
		 * 用于删除操作前判断后续消息是否包含分支，以决定是否弹出警告。
		 * @param {AiChat.Message} message
		 * @returns {boolean} 如果从该消息到叶子的路径上存在分支点则返回 true
		 */
		hasBranch(message) {
			let i = message[INDEX];
			while (true) {
				if (message?.[CHILDREN]) return true;
				if (isLeaf(message)) return false;
				message = messages[++i];
			}
		},

		/**
		 * 折叠路径上的消息范围 [start, end]（含端点），支持嵌套。
		 * @param {number} start
		 * @param {number} end
		 * @param {Object} payload
		 * @param {string} [foldId]
		 * @param {boolean} [skipUpdate]
		 * @returns {AiChat.FoldedMessage | void}
		 */
		fold(start, end, payload, foldId, skipUpdate) {
			if (messages[0] !== SENTRY) throwDOMException(DESTROYED_MESSAGE_SHOULD_NOT_HAPPEN, "InvalidStateError");

			for (let k = start; k <= end; k++) {
				const msg = path[k];
				if (msg.id < 0) throwDOMException("不能折叠虚拟消息", FSE_NotAllowed);

				const children = msg[CHILDREN];
				if (children?.length > 1) throwDOMException("折叠范围包含分支", FSE_NotAllowed);

				if (k < end) {
					if (msg[FOLDED_MESSAGES]?.at(-1)[CHILDREN]?.length > 1)
						throwDOMException("折叠范围包含分支", FSE_NotAllowed);
				}
			}

			let tail = path[end];
			const tailFolded = tail[FOLDED_MESSAGES];
			if (tailFolded) tail = tailFolded.at(-1);

			(tail.folded ??= []).push(payload);

			if (!foldId) foldId = tail.id + "_" + getRandomString(4);
			for (let k = start; k <= end; k++) {
				const msg = path[k];
				const folded = msg[FOLDED_MESSAGES];
				if (folded) {
					for (const msg of folded) {
						msg.foldGroup.push(foldId);
						markMessageDirty(msg);
					}
				} else {
					if (msg.foldGroup != null) showToast("msg.foldGroup != null", "error");

					msg.foldGroup = [foldId];
					markMessageDirty(msg);
				}
			}

			if (skipUpdate) return;
			updatePath();
			return path[start];
		},
		/**
		 * 解开折叠块
		 * @param {AiChat.FoldedMessage} block
		 * @return {AiChat.Message[]}
		 */
		unfold(block) {
			const folded = block[FOLDED_MESSAGES];

			const payloads = folded.at(-1).folded;
			payloads.pop();
			if (!payloads.length) delete folded.at(-1).folded;

			for (const m of folded) {
				const arr = m.foldGroup;
				if (arr?.at(-1) === block.group) {
					arr.pop();
					if (!arr.length) delete m.foldGroup;
					markMessageDirty(m);
				}
			}

			const inUse = messages.some(m => m.parent != null || m.foldGroup != null);
			if (!inUse) deactivate();
			else updatePath();

			return folded;
		},

		update: updatePath,
	}

	for (const name in proto) {
		Object.defineProperty(path, name, {
			value: proto[name],
			writable: true,
			configurable: true,
			enumerable: false,
		});
	}

	// 初始化时更新
	updatePath();

	if (unconscious(reactiveMessages) === messages)
		reactiveMessages.value = path;

	return path;
}

/**
 * 为会话启用分支管理器，初始化消息树结构并返回当前分支的消息路径。
 * @param {AiChat.Conversation} conv - 会话对象，会在其上挂载 BRANCH_MANAGER
 * @returns {AiChat.BranchManager} 当前分支的消息路径（带有 hook 的数组）
 */
export const enableBranches = (conv) => {
	conv = unconscious(conv);
	const rawMessage = getImmediateMessages(conv, true);
	return rawMessage[BRANCH_MANAGER] ??= createBranchManager(conv, rawMessage);
}

export const enableBranchesForTest = (conv, msgForTestOnly) => conv[BRANCH_MANAGER] ??= createBranchManager(conv, msgForTestOnly);

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

export const switchBranch = async (oldMessages, newMessages, conv) => {
	let prefix = 0;
	for (; prefix < Math.min(oldMessages.length, newMessages.length); prefix++) {
		if (oldMessages[prefix] !== newMessages[prefix]) break;
	}
	EVENT_BUS.post(['switchBranch'], conv, oldMessages, newMessages, prefix);
	undoToolCalls(conv, oldMessages, prefix, true);
	redoToolCalls(conv, newMessages, prefix, true);
};

/**
 * 展开所有被禁用的折叠块。
 * @param {AiChat.Message[]} list
 * @param {boolean} [unfold]
 * @returns {AiChat.Message[]}
 */
export function expandFolds(list, unfold) {
	const out = [];
	let changed = false;
	(function walk(arr) {
		for (const m of arr) {
			if (m.role === 'fold' && (m.disabled || unfold)) {
				changed = true;
				walk(m[FOLDED_MESSAGES]);
			} else {
				out.push(m);
			}
		}
	})(list);
	return changed ? out : list;
}