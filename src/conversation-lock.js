import {EVENT_BUS} from "./states.js";

// 这里是本地锁（缓存驱逐和服务器同步用）
// [LOCKED] 符号是远程锁，服务器报告另外一端打开。
/** @type {Map<number, number>} */
export const conversationLock = new Map;

/**
 * @param {number} id
 */
export const lockConversation = (id) => {
	if (typeof id !== 'number') return;
	let lockCount = (conversationLock.get(id) || 0);
	conversationLock.set(id, lockCount + 1);
	if (!lockCount) EVENT_BUS.post(['lock'], id);
};

/**
 * @param {number} id
 */
export const unlockConversation = (id) => {
	let lockCount = conversationLock.get(id);
	if (!lockCount) return;
	if (lockCount === 1) {
		conversationLock.delete(id);
		EVENT_BUS.post(['unlock'], id);
	} else {
		conversationLock.set(id, lockCount - 1);
	}
};