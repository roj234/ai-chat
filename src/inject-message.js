import {EVENT_BUS, LOCKED, runningConversations} from "/src/states.js";
import {getMessages, updateConversation} from "/src/database.js";
import {submitUserChatMessage} from "./api-request.js";
import {lockConversation, unlockConversation} from "./conversation-lock.js";

/**
 * 向会话注入消息。
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message} items
 */
export const injectMessages = async (conv, ...items) => {
	if (conv[LOCKED]) return;

	if (runningConversations.has(conv.id)) {
		!conv.pendingMessages ? conv.pendingMessages = items : conv.pendingMessages.push(...items);
		EVENT_BUS.post(['messageInject', 'pending'], conv);
		await updateConversation(conv);
		return false;
	}

	let msgs, last;
	lockConversation(conv.id);
	try {
		msgs = await getMessages(conv);
		last = msgs.at(-1);
		if (cannotInsertAfter(last)) return false;

		msgs.push(...items);
		await updateConversation(conv, msgs);
	} finally {
		unlockConversation(conv.id);
	}

	submitUserChatMessage(true, conv);
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
		const last = messages.at(-1);
		if (cannotInsertAfter(last)) return;

		messages.push(...pm);
		delete conv.pendingMessages;

		EVENT_BUS.post(['messageInject', 'flushed'], conv);
		queueMicrotask(() => { submitUserChatMessage(true); });
		return updateConversation(conv, messages);
	}
}

EVENT_BUS.on(['loopBegin'], conv => flushNotifications(conv, runningConversations.get(conv.id).messages));
EVENT_BUS.on(['loopEnd'], conv => flushNotifications(conv, runningConversations.get(conv.id).messages));
