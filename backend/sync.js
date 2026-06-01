import {
	SYNC_CONFLICT,
	SYNC_CONVERSATION,
	SYNC_INIT,
	SYNC_LOCKED,
	SYNC_MESSAGE,
	SYNC_PING,
	SYNC_READERS,
	SYNC_RELEASED,
	SYNC_RESOLVE,
	SYNC_UNLOCKED
} from "./sync_const.js";

/**
 *
 * @type {Map<string, Set<{
 *     locked: Map<number, boolean>,
 *     ws: WebSocket
 * }>>}
 */
const lockMap = new Map;

export function createSyncManager(wss) {
	wss.on('connection', (ws, req) => {
		const baseUrl = `http://${req.headers.host}`;
		const myUrl = new URL(req.url, baseUrl);
		const userId = myUrl.searchParams.get('user');

		/** @type {Map<number, boolean>} */
		const myLocked = new Map;
		const self = {
			locked: myLocked,
			ws
		};

		const users = lockMap.get(userId) || new Set;
		users.add(self);
		lockMap.set(userId, users);

		{
			let locked = new Set;
			// AI常见误区：读锁也被当作"已锁定"发给客户端，客户端会把这些对话标记为 LOCKED 显示，但实际上读锁不应该阻塞别人。
			// 但是我的设计必然存在写者，不可能只有读者，所以这个问题不存在
			for (const user of users) user.locked.keys().forEach(item => locked.add(item));
			locked.delete(0);

			ws.send(JSON.stringify([
				SYNC_INIT,
				[
					users.size,
					Array.from(locked)
				]
			]));
		}

		ws.on('error', (err) => {
			console.error('连接错误:', err.message);
		});

		ws.on('close', () => {
			users.delete(self);
			for (const [id, writeLock] of myLocked.entries()) {
				if (writeLock) onUnlock(id);
			}
		});

		function updateReaderCount(id) {
			let owner;
			let count = 0;
			for (let user of users) {
				if (user.locked.has(id)) {
					if (user.locked.get(id)) {
						owner = user;
					} else {
						count = 1;
						break;
					}
				}
			}

			owner.ws.send(JSON.stringify([
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
					users.has(self) && self.ws.send(JSON.stringify([
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
			for (const user of users) {
				if (user !== self && user.locked.get(id))
					return user;
			}
		}

		function sendToLockOwner(id, data, allowReader) {
			const str = JSON.stringify(data);
			let reader;
			for (const user of users) {
				if (user !== self) {
					if (user.locked.get(id)) {
						if (id !== 0) user.ws.send(str);
						return user;
					}
					if (user.locked.has(id)) {
						reader = user;
					}
				}
			}

			// 如果没有写持有者，将消息发给随机的读持有者，让它升级
			if (allowReader && reader) {
				if (id !== 0) reader.ws.send(str);
				return reader;
			}
		}

		function broadcastExcludeSelf(data) {
			if (data[1] === 0) return;

			const str = JSON.stringify(data);
			for (const user of users) {
				if (user !== self) user.ws.send(str);
			}
		}

		ws.on('message', (message) => {
			try {
				const [type, data] = JSON.parse(message.toString('utf-8'));
				switch (type) {
					case SYNC_PING:
						ws.send(JSON.stringify([SYNC_PING]));
					break;
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

							const syncReaders = JSON.stringify([
								SYNC_READERS,
								[ data, 1 ]
							]);

							if (data !== 0) {
								ws.send(JSON.stringify([
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
					case SYNC_MESSAGE:
						broadcastExcludeSelf([
							SYNC_MESSAGE,
							data
						]);
					break;
					case SYNC_CONVERSATION:
						broadcastExcludeSelf([
							SYNC_CONVERSATION,
							data
						]);
					break;
				}
			} catch (e) {
				console.error(e);
				ws.send(JSON.stringify({ error: "invalid message" }));
				ws.close();
			}
		});
	});

	return wss;
}