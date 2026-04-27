
/**
 *
 * @type {Map<string, Set<{
 *     locked: Set<number>,
 *     ws: WebSocket
 * }>>}
 */
const lockMap = new Map;

export function createSyncManager(wss) {
	wss.on('connection', (ws, req) => {
		const baseUrl = `http://${req.headers.host}`;
		const myUrl = new URL(req.url, baseUrl);
		const userId = myUrl.searchParams.get('user');

		const myLocked = new Set;
		const value = {
			locked: myLocked,
			ws
		};

		const userData = lockMap.get(userId) || new Set;
		userData.add(value);
		lockMap.set(userId, userData);

		{
			let locked = new Set;
			for (const v of userData) v.locked.forEach(item => locked.add(item));

			ws.send(JSON.stringify({
				type: "init",
				data: userData.size,
				locked: Array.from(locked)
			}));
		}

		ws.on('close', () => {
			userData.delete(value);
			for (const v of userData) {
				for (const id of myLocked) {
					if (v.locked.has(id)) {
						v.ws.send(JSON.stringify({
							type: "released",
							data: {
								id
							}
						}));
						break;
					}
				}
			}
		});

		ws.on('message', (message) => {
			try {
				const {type, data} = JSON.parse(message.toString('utf-8'));
				switch (type) {
					case "update":
						for (const v of userData) {
							if (v !== value) {
								v.ws.send(JSON.stringify({
									type: "update",
									data: {
										id: data.id,
										conv: data
									}
								}));
							}
						}
						break;
					case "resolve":
						// 强制解锁
						if (myLocked.has(data)) {
							for (const v of userData) {
								if (v !== value && v.locked.has(data)) {
									v.ws.send(JSON.stringify({
										type: "unlock",
										data: data
									}))
								}
							}
						}
						break;
					case "lock":
						myLocked.add(data);
						for (const v of userData) {
							if (v !== value && v.locked.has(data)) {
								ws.send(JSON.stringify({
									type: "conflict",
									data
								}));
								break;
							}
						}
						break;
					case "unlock":
						myLocked.delete(data.id);
						delete data.ready;
						for (const v of userData) {
							if (v !== value && v.locked.has(data.id)) {
								v.ws.send(JSON.stringify({
									type: "released",
									data
								}));
								break;
							}
						}
						break;
					case "delete":
						for (const v of userData) {
							if (v !== value) {
								v.ws.send(JSON.stringify({
									type: "update",
									data: {
										id: data,
										// 没有conv就是删除
									}
								}));
							}
						}
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