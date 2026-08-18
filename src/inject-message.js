import {$update, unconscious} from "unconscious";
import {EVENT_BUS, LOCKED, messages, runningConversations, selectedConversation, updateMessageUI} from "/src/states.js";
import {getMessagesCacheFirst, updateConversation} from "/src/database.js";
import {enableBranches} from "/src/utils/BranchManager.js";
import {submitUserChatMessage} from "./api-request.js";

/**
 * 向会话注入消息。
 *
 * @param {AiChat.Conversation} conv
 * @param {AiChat.Message[]} items
 */
export const appendMessages = async (conv, items) => {
	if (conv[LOCKED]) return;

	if (runningConversations.has(conv.id)) {
		!conv.pendingMessages ? conv.pendingMessages = items : conv.pendingMessages.push(...items);
		await updateConversation(conv);
		return false;
	}

	const cached = await getMessagesCacheFirst(conv, false);
	const msgs = conv.bm_leaf ? enableBranches(conv, cached) : cached;
	const last =  msgs.at(-1);
	msgs.push(...items);
	await updateConversation(conv, msgs);

	if (unconscious(selectedConversation)?.id === conv.id) {
		messages.value = msgs;
		$update(updateMessageUI);

		if (last?.finish_reason === 'stop') {
			submitUserChatMessage(true);
			return true;
		}
	}

	return true;
};

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
		messages.push(...pm);
		delete conv.pendingMessages;

		if (unconscious(selectedConversation)?.id === conv.id) {
			$update(updateMessageUI);
			if (last?.finish_reason === 'stop') {
				queueMicrotask(() => {
					submitUserChatMessage(true).catch(() => {});
				});
			}
		}

		return updateConversation(conv, messages);
	}
}

EVENT_BUS.on(['loopBegin'], conv => flushNotifications(conv, runningConversations.get(conv.id).messages));
EVENT_BUS.on(['loopEnd'], conv => flushNotifications(conv, runningConversations.get(conv.id).messages));
