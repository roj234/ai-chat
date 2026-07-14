
const ERROR_MESSAGE = "IndexedDB 操作被阻塞，请关闭其他使用该数据库的标签页";

/**
 *
 * @param {string} dbName
 * @param {number} dbVersion
 * @param {function(IDBVersionChangeEvent): void} upgrade_callback
 * @returns {[
 * function(function(tx: IDBTransaction, resolve: function(*): void): (void|IDBRequest<*>), write: boolean=, ...[string]): Promise<*>,
 * function(): Promise<unknown>
 * ]}
 */
export const IndexedDBAccess = (dbName, dbVersion, upgrade_callback) => {
	let db;

	/**
	 * 打开并返回数据库实例
	 * @returns {Promise<IDBDatabase>}
	 */
	const openDb = () => new Promise((resolve, reject) => {
		navigator.storage?.persist();

		const request = indexedDB.open(dbName, dbVersion);
		request.onupgradeneeded = upgrade_callback;

		request.onsuccess = (event) => {
			const db = event.target.result;
			// 长期持有连接时建议监听 close
			db.onversionchange = () => {
				db.close();
				alert('Database version changed, please reload page.');
			};
			resolve(db);
		};

		request.onerror = (event) => {
			reject(new Error(`Database error: ${event.target.error?.message || event.target.error}`));
		};

		request.onblocked = () => reject(ERROR_MESSAGE);
	});

	let batchQueue;
	let batchWrite;
	let batchStore;

	const runBatch = async () => {
		const queue = batchQueue;
		const stores = [...batchStore];
		const mode = batchWrite ? "readwrite": "readonly";
		batchQueue = batchStore = batchWrite = 0;

		const tx = (db || (db = await openDb())).transaction(stores, mode);
		tx.onerror = () => {
			const error = new Error(tx.error?.message);
			for (const el of queue) el[2](error);
		};
		for (const [fn, resolve] of queue) {
			const v = fn(tx, resolve);
			if (v) v.onsuccess = (event) => resolve(event.target.result);
		}
	};

	/**
	 *
	 * @param {function(tx: IDBTransaction, resolve: (value: (PromiseLike<unknown> | unknown)) => void): void | IDBRequest<unknown>} callback
	 * @param {boolean=} write
	 * @param {string} database
	 * @return {Promise<unknown>}
	 */
	const transaction = (callback, write, ...database) => new Promise((resolve, reject) => {
		const data = [ callback, resolve, reject ];
		if (!batchQueue) {
			batchQueue = [data];
			batchStore = new Set(database);
			setTimeout(runBatch);
		} else {
			batchQueue.push(data);
			database.forEach(item => batchStore.add(item));
		}
		batchWrite |= write;
	});

	const deleteDatabase = async () => {
		if (db) db.close();

		const req = indexedDB.deleteDatabase(dbName);
		return new Promise((resolve, reject) => {
			req.onsuccess = resolve;
			req.onerror = reject;
			req.onblocked = () => reject(ERROR_MESSAGE);
		});
	};

	return [transaction, deleteDatabase];
}