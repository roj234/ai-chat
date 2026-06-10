/**
 * Service Worker: Blob LRU 缓存
 */

const CACHE_NAME = 'blob-cache-v1';
const BLOB_URL_PATTERN = /\/api\/v2.*\/blob\/[a-zA-Z0-9\-_]+/;

// ===== 生命周期 =====
self.addEventListener('install', (event) => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

// ===== 请求拦截 =====
self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (!BLOB_URL_PATTERN.test(request.url)) return;
	if (request.method === 'GET') {
		event.respondWith(handleGetBlobRequest(request, event));
	} else if (request.method === 'POST') {
		event.respondWith(handleSetBlobRequest(request, event));
	}
});

/** 默认容量 = 最大容量, 500 MB */
let CACHE_CAPACITY = 500<<20;
const SUMSIZE = '_sumSize_';

/**
 * @type {Promise<IDBDatabase>}
 */
const db = new Promise((resolve, reject) => {
	const req = indexedDB.open(APP_NAME+':sw', 1);
	req.onupgradeneeded = (event) => {
		const db = event.target.result;
		const caches = db.createObjectStore('caches', { keyPath: 'url' });
		caches.createIndex('time', 'time');
		caches.put({ url: SUMSIZE, size: 0 });
	};
	req.onsuccess = (event) => resolve(event.target.result);
	req.onerror = reject;
});

// ===== 缓存核心逻辑 =====

/**
 * 处理 POST 请求，上传成功后预缓存
 * @param {Request} request
 * @param {FetchEvent} event
 */
const handleSetBlobRequest = async (request, event) => {
	const blob = await request.blob();

	const response = await fetch(request.url, {
		method: "POST",
		headers: request.headers,
		body: blob
	});

	if (response.status === 200 || response.status === 201) {
		const url = new URL(request.url);
		const name = url.searchParams.get("name");
		const time = url.searchParams.get("time");

		const headers = {
			'Content-Type': blob.type,
			'Content-Length': blob.size,
			'Last-Modified': new Date(parseInt(time, 10) || Date.now()).toUTCString(),
		};
		if (name) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(name)}"`;

		const cloned = new Response(blob, {headers});
		const cache = await caches.open(CACHE_NAME);
		let input = request.url;
		let pos = input.indexOf('?');
		const fakeRequest = new Request(pos > 0 ? input.slice(0, pos) : input, { method: 'GET' });
		handleAddCache(event, fakeRequest, cloned, cache);
	}
	return response;
};

/**
 * 处理匹配的 blob 请求（缓存优先）
 * @param {Request} request
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
const handleGetBlobRequest = async (request, event) => {
	const cache = await caches.open(CACHE_NAME);
	const cachedResponse = await cache.match(request);

	if (cachedResponse) {
		event.waitUntil(updateAccessTime(request.url));
		return cachedResponse;
	}

	// 浏览器可能发起 opaque 请求，比如背景图
	const networkResponse = await fetch(request.url, { mode: 'cors' });
	if (networkResponse.ok) {
		const clonedResponse = networkResponse.clone();
		handleAddCache(event, request, clonedResponse, cache);
	}

	return networkResponse;
};

const handleAddCache = (event, request, response, cache) => {
	const size = parseInt(response.headers.get('content-length'), 10) || 0;
	if (size > CACHE_CAPACITY) return;

	event.waitUntil(
		Promise.all([
			addToCache(request.url, size),
			cache.put(request, response)
		]).then(() => trimCache(CACHE_CAPACITY))
	);
};


/**
 * 添加缓存条目，更新 currentSize
 * 若 URL 已存在则替换，正确调整大小差量
 * @param {string} url
 * @param {number} size
 */
async function addToCache(url, size) {
	const tx = (await db).transaction('caches', 'readwrite');
	const store = tx.objectStore('caches');

	const getReq = store.get(url);
	getReq.onsuccess = () => {
		const existing = getReq.result;
		if (existing) return;

		console.log('[SW] Add '+url);
		store.put({ url, time: Date.now(), size });

		const sizeReq = store.get(SUMSIZE);
		sizeReq.onsuccess = () => {
			const value = sizeReq.result;
			value.size += size;
			store.put(value);
		};
	};

	await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
}

/**
 * 更新指定 URL 的访问时间（不改变总容量）
 * @param {string} url
 */
const updateAccessTime = async url => {
	const getReq = (await db).transaction('caches', 'readonly').objectStore('caches').get(url);
	return new Promise((resolve, reject) => {
		getReq.onsuccess = () => {
			const entry = getReq.result;
			if (entry && Date.now() - entry.time > 60000) {
				return resolve(checkValidity(url));
			}
			resolve();
		};
		getReq.onerror = reject;
	});
};

/**
 *
 * @param {string} url
 * @return {Promise<unknown>}
 */
async function checkValidity(url) {
	let status;
	try {
		status = (await fetch(url, {headers: {Range: 'bytes=0-0'}})).status;
	} catch (err) {
		console.error('[SW] checkValidity err', err);
		return;
	}
	const fail = status >= 400;

	const tx = (await db).transaction('caches', 'readwrite');
	const store = tx.objectStore('caches');

	const getReq = store.get(url);
	getReq.onsuccess = () => {
		const entry = getReq.result;
		if (!entry) return;

		if (!fail) {
			console.log('[SW] Touch '+url);
			entry.time = Date.now();
			store.put(entry);
			return;
		}

		console.log('[SW] Delete '+url);
		store.delete(entry.url);

		const sizeReq = store.get(SUMSIZE);
		sizeReq.onsuccess = () => {
			const sumSize = sizeReq.result;
			sumSize.size -= entry.size;
			store.put(sumSize);
		};
	};

	const promises = [
		new Promise((resolve, reject) => {
			tx.oncomplete = resolve;
			tx.onerror = reject;
		})
	];

	if (fail) promises.push(caches.open(CACHE_NAME).then(cache => cache.delete(url)));

	return Promise.all(promises);
}

// ===== 容量管理 =====

/**
 * 获取当前元数据值
 * @returns {Promise<number>}
 */
const readSumSize = async () => {
	const req = (await db).transaction('caches', 'readonly').objectStore('caches').get(SUMSIZE);
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result.size);
		req.onerror = reject;
	});
};

/**
 * LRU 清理：按时间升序遍历缓存，删除最旧条目直到总大小 ≤ maxSize
 * 使用游标避免全量加载，性能优化显著
 * @param {number} maxSize - 最大字节数
 */
const trimCache = async (maxSize) => {
	let currentSize = await readSumSize();
	if (currentSize <= maxSize) return [currentSize, currentSize];

	const init = currentSize;
	const cache = await caches.open(CACHE_NAME);

	const tx = (await db).transaction('caches', 'readwrite');
	const store = tx.objectStore('caches');
	const cursorReq =  store.index('time').openCursor(null, 'next');

	const pendingPromises = [];
	await new Promise((resolve, reject) => {
		tx.oncomplete = resolve;
		tx.onerror = reject;

		cursorReq.onsuccess = (event) => {
			/** @type {IDBCursorWithValue} */
			const cursor = event.target.result;
			if (!cursor || currentSize <= maxSize) {
				store.put({ url: SUMSIZE, size: currentSize });
				return;
			}

			const entry = cursor.value;
			pendingPromises.push(cache.delete(entry.url));
			currentSize -= entry.size;

			cursor.delete();
			cursor.continue();
		};
	});
	await Promise.all(pendingPromises);
	return [init, currentSize];
};

// 自毁兼清理
async function unregisterAndCleanup() {
	await caches.delete(CACHE_NAME);
	(await db).close();
	await new Promise((resolve, reject) => {
		const req = indexedDB.deleteDatabase(APP_NAME+':sw');
		req.onsuccess = resolve;
		req.onerror = reject;
	});
}

// ===== 消息处理 =====
self.addEventListener('message', (event) => {
	const [ id, type, value ] = event.data;
	const client = event.source;

	let fn;

	switch (type) {
		case 'get':
			fn = readSumSize();
			break;
		case 'set':
			if (typeof value === 'number' && value >= 0) {
				CACHE_CAPACITY = value;
				fn = trimCache(value);
			}
			break;
		case 'del':
			fn = unregisterAndCleanup();
			break;
	}
	if (fn) event.waitUntil(fn.then((value) => client.postMessage([ id, value ])));
});