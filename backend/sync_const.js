
export const
	SYNC_INIT = 0,
	SYNC_LOCKED = 1,
	SYNC_UNLOCKED = 2,
	SYNC_RESOLVE = 3,
	SYNC_CONFLICT = 4,
	SYNC_RELEASED = 5,
	SYNC_CONVERSATION = 6,
	SYNC_MESSAGE = 7,
	SYNC_READERS = 8,
	SYNC_PING = 9;

export const PROTOCOL_VERSION = 1;

export const sortMessages = (messages) => messages.sort((a, b) => {
	const b1 = a.role === "system";
	const b2 = b.role === "system";
	if (b1 !== b2) return b2 - b1;
	return 0;
});