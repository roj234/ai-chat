import {EVENT_BUS, LOCKED, runningConversations} from "/src/states.js";
import {getMessages, updateConversation} from "/src/database.js";
import {submitUserChatMessage} from "./api-request.js";
import {lockConversation, unlockConversation} from "./conversation-lock.js";

function doInsert(msgs, items) {
	const last = msgs.at(-1);
	if (cannotInsertAfter(last)) return items;

	const deferred = [];
	const flag = last.finish_reason !== 'stop';
	for (let item of items) {
		if (item.defer) {
			if (flag) {
				deferred.push(item);
				continue;
			}

			delete item.defer;
		}

		msgs.push(item);
	}

	return deferred;
}

/**
 * 向会话注入消息。
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message} items
 */
export const injectMessages = async (conv, ...items) => {
	if (conv[LOCKED]) return;

	if (runningConversations.has(conv.id)) {
		(conv.pendingMessages??=[]).push(...items);
		EVENT_BUS.post(['messageInject', 'pending'], conv);
		await updateConversation(conv);
		return false;
	}

	let msgs;
	lockConversation(conv.id);
	try {
		msgs = await getMessages(conv);
		const remain = doInsert(msgs, items);
		if (remain.length) {
			(conv.pendingMessages??=[]).push(...remain);
		}
		await updateConversation(conv, msgs);
	} finally {
		unlockConversation(conv.id);
	}

	submitUserChatMessage(true, conv).catch(() => {});
	return true;
};

/**
 *
 * @param {AiChat.Message} m
 * @return {boolean}
 */
export const cannotInsertAfter = m => m?.role === 'assistant' && (m.error || m.finish_reason === 'interrupt' || m.finish_reason === 'length');

/**
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} messages
 * @return {void | Promise<void>}
 */
export const flushNotifications = (conv, messages) => {
	const pm = conv.pendingMessages;
	if (pm && !conv[LOCKED]) {
		const remain = doInsert(messages, pm);
		if (remain.length) conv.pendingMessages = remain;
		else delete conv.pendingMessages;

		EVENT_BUS.post(['messageInject', 'flushed'], conv);
		queueMicrotask(() => {
			submitUserChatMessage(true, conv).catch(() => {});
		});
		return updateConversation(conv, messages);
	}
}

EVENT_BUS.on(['loopBegin'], conv => flushNotifications(conv, runningConversations.get(conv.id).messages));
EVENT_BUS.on(['loopEnd'], conv => flushNotifications(conv, runningConversations.get(conv.id).messages));
