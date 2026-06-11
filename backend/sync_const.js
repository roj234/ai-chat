
export const
	SYNC_INIT = 0,
	SYNC_LOCKED = 1,
	SYNC_UNLOCKED = 2,
	SYNC_RESOLVE = 3,
	SYNC_CONFLICT = 4,
	SYNC_RELEASED = 5,
	SYNC_READERS = 6,
	SYNC_PING = 7,
	SYNC_ERROR = 8,
	SYNC_CONVERSATION = 9,
	SYNC_CONVERSATION_DEL = 10,
	SYNC_MESSAGE = 11,
	SYNC_MESSAGE_DEL = 12,
	SYNC_KV = 13,
	SYNC_KVS = 14,
	SYNC_KVS_DEL = 15
;

export const PROTOCOL_VERSION = 2;

export const sortMessages = (messages) => messages.sort((a, b) => {
	const b1 = a.role === "system";
	const b2 = b.role === "system";
	if (b1 !== b2) return b2 - b1;
	return 0;
});