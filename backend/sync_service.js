import {
	SYNC_CONFLICT,
	SYNC_CONVERSATION,
	SYNC_CONVERSATION_DEL,
	SYNC_ERROR,
	SYNC_INIT,
	SYNC_KV,
	SYNC_KVS,
	SYNC_KVS_DEL,
	SYNC_LOCKED,
	SYNC_MESSAGE,
	SYNC_MESSAGE_DEL,
	SYNC_PING,
	SYNC_READERS,
	SYNC_RELEASED,
	SYNC_RESOLVE,
	SYNC_UNLOCKED
} from "./sync_const.js";
import {ALLOW_USER_NAMES, INTERACTIVE_LOGIN, RESPONSE_USE_MSGPACK_SCHEMA, RESTRICT_USER_CREATION} from "./config.js";
import {checkPAT} from "./utils/PAT.js";
import {loadUserData} from "./utils/UserManager.js";
import {decodeMsg, encodeMsg} from "unconscious/common/msgpack.js";
import {msgpack_schema} from "../common/MsgpackSchema.js";

/**
 *
 * @param {string} DATA_PATH
 * @return {(function({req: http.IncomingMessage, secure: boolean, origin: string}, function(boolean, number=, string=, Headers=): void): void)|*}
 */
export const createSyncValidateMiddleware = (DATA_PATH) => /**
	 * @param {{ req: http.IncomingMessage, secure: boolean, origin: string }} info
	 * @param {(allowed: boolean, code?: number, message?: string, headers?: Headers) => void} cb
	 */({req}, cb) => {

	const baseUrl = `http://${req.headers.host}`;
	const myUrl = new URL(req.url, baseUrl);

	const userId = myUrl.searchParams.get('u');
	const pat = myUrl.searchParams.get('t');
	if (RESTRICT_USER_CREATION && !ALLOW_USER_NAMES.has(userId)) {
		cb(false, 403, "no such user");
		return;
	}

	const emulatedCtx = { req };
	Object.defineProperty(emulatedCtx, 'db', {
		get: () => loadUserData(DATA_PATH, userId).sqlite
	});

	if (INTERACTIVE_LOGIN && !checkPAT(pat || "", emulatedCtx)) {
		cb(false, 401, "invalid or missing PAT");
		return;
	}

	req._userId = userId;
	cb(true);
}

/**
 *
 * @param {WebSocketServer} wss
 * @return {AiChatBackend.SyncManager}
 */
export function createSyncManager(wss) {
	const encode = RESPONSE_USE_MSGPACK_SCHEMA ? (data) => encodeMsg(data, msgpack_schema) : JSON.stringify;

	/**
	 *
	 * @type {Map<string, Set<{
	 *     locked: Map<number, boolean>,
	 *     ws: WebSocket,
	 *     id: string
	 * }>>}
	 */
	const users = new Map;

	wss.on('connection', (ws, req) => {
		/** @type {string} */
		const userId = req._userId;
		const clientId = Math.random().toString(36).slice(2);

		/** @type {Map<number, boolean>} */
		const myLocked = new Map;
		const self = {
			locked: myLocked,
			ws,
			id: clientId
		};

		let clients = users.get(userId);
		if (!clients) users.set(userId, clients = new Set([self]));
		else clients.add(self);

		{
			let locked = new Set;
			// AI常见误区：读锁也被当作"已锁定"发给客户端，客户端会把这些对话标记为 LOCKED 显示，但实际上读锁不应该阻塞别人。
			// 但是我的设计必然存在写者，不可能只有读者，所以这个问题不存在
			for (const client of clients) client.locked.keys().forEach(item => locked.add(item));
			locked.delete(0);

			ws.send(encode([
				SYNC_INIT,
				[
					clients.size,
					Array.from(locked),
					clientId
				]
			]));
		}

		ws.on('error', (err) => {
			console.error('连接错误:', err.message);
		});

		ws.on('close', () => {
			clients.delete(self);
			for (const [id, writeLock] of myLocked.entries()) {
				if (writeLock) onUnlock(id);
			}
		});

		function updateReaderCount(id) {
			let owner;
			let count = 0;
			for (let client of clients) {
				if (client.locked.has(id)) {
					if (client.locked.get(id)) {
						owner = client;
					} else {
						count = 1;
						break;
					}
				}
			}

			owner.ws.send(encode([
				SYNC_READERS,
				[
					id,
					count
				]
			]));
		}

		function onUnlock(id) {
			const owner = sendToLockOwner(id, [
				SYNC_RELEASED,
				id
			], true);
			if (!owner) {
				broadcastExcludeSelf([
					SYNC_UNLOCKED,
					id
				]);
			} else {
				if (id !== 0) {
					clients.has(self) && self.ws.send(encode([
						SYNC_LOCKED,
						id
					]));
				}

				// 自动升级
				owner.locked.set(id, true);
				updateReaderCount(id);
			}
		}

		function findLockOwner(id) {
			for (const client of clients) {
				if (client !== self && client.locked.get(id))
					return client;
			}
		}

		function sendToLockOwner(id, data, allowReader) {
			const body = encode(data);
			let reader;
			for (const client of clients) {
				if (client !== self) {
					if (client.locked.get(id)) {
						if (id !== 0) client.ws.send(body);
						return client;
					}
					if (client.locked.has(id)) {
						reader = client;
					}
				}
			}

			// 如果没有写持有者，将消息发给随机的读持有者，让它升级
			if (allowReader && reader) {
				if (id !== 0) reader.ws.send(body);
				return reader;
			}
		}

		function broadcastExcludeSelf(data) {
			if (data[1] === 0) return;

			const body = encode(data);
			for (const client of clients) {
				if (client !== self) client.ws.send(body);
			}
		}

		ws.on('message', async (message, isBinary) => {
			try {
				const [type, data] = isBinary ? decodeMsg(message, {schema: msgpack_schema}) : JSON.parse(message.toString());
				switch (type) {
					default: throw new Error("unknown message type");

					case SYNC_PING: ws.send(encode([SYNC_PING])); break;
					// 消息锁管理
					case SYNC_RESOLVE:
						if (typeof data !== "number" || data === 0) return;

						// 强制解锁
						if (myLocked.has(data)) {
							const owner = sendToLockOwner(data, [
								SYNC_RESOLVE,
								data
							]);
							// 切到读锁
							if (owner) owner.locked.set(data, false);
							// 升级为写锁
							myLocked.set(data, true);
						}
					break;
					case SYNC_LOCKED: {
						if (typeof data !== "number") return;

						const owner = findLockOwner(data);
						if (owner) {
							// false => 读锁
							myLocked.set(data, false);

							const syncReaders = encode([
								SYNC_READERS,
								[ data, 1 ]
							]);

							if (data !== 0) {
								ws.send(encode([
									SYNC_CONFLICT,
									data
								]));
							} else {
								ws.send(syncReaders);
							}
							owner.ws.send(syncReaders);
						} else {
							// true => 写锁
							myLocked.set(data, true);
							broadcastExcludeSelf([
								SYNC_LOCKED,
								data
							]);
						}
					}
					break;
					case SYNC_UNLOCKED: {
						if (typeof data !== "number") return;

						const writeLock = myLocked.get(data);
						if (!myLocked.delete(data)) return;
						if (writeLock) onUnlock(data);
						else updateReaderCount(data);
					}
					break;
				}
			} catch (e) {
				console.error(e);
				ws.send(encode([SYNC_ERROR, { status: 400, message: e.message || e }]));
				ws.close();
			}
		});
	});

	return {
		/**
		 *
		 * @param {AiChatBackend.RouteContext} ctx
		 * @param {string} func
		 * @param {*} body
		 * @param resp
		 */
		onBatch(ctx, func, body, resp) {
			const clientId = ctx.req.headers['x-ci'];
			let shouldSend = (client) => client.id !== clientId;

			let code;
			switch (func) {
				default: return;
				case 'conversation/upsert':
					code = SYNC_CONVERSATION;
					body.id = resp;
				break;
				case 'conversation/delete':
					code = SYNC_CONVERSATION_DEL;
					body = {id: body};
				break;
				case 'message/upsert':
					code = SYNC_MESSAGE;
					body.id = resp;
					shouldSend = (client) => client.id !== clientId && client.locked.has(body.owner);
				break;
				case 'message/delete':
					code = SYNC_MESSAGE_DEL;
					body = {id: body};
					shouldSend = (client) => client.id !== clientId && client.locked.has(body.owner);
				break;
				case 'kv/set':
					code = SYNC_KV;
				break;
				case 'kv/delete':
					code = SYNC_KV;
					body = [body];
				break;
				case 'kvs/upsert':
					code = SYNC_KVS;
					body = [body.type, body.name];
				break;
				case 'kvs/delete':
					code = SYNC_KVS_DEL;
				break;
			}

			const clients = users.get(ctx.params.userId);
			if (!clients) return;

			const encodedBody = encode([code, body]);
			for (const client of clients) {
				if (shouldSend(client)) {
					client.ws.send(encodedBody);
				}
			}
		}
	};
}