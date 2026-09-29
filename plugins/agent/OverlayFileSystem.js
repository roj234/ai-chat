/**
 * Overlay (Copy-on-Write) File System in Chrome
 */
import {normalizePath} from "unconscious/common/path-utils.js";
import {copyEntry, CREATE_OPT, RECURSIVE, resolveDirectory} from "./WebFSUtils.js";
import {createAsyncQueue, FSE_NotFound, throwDOMException} from "/common/pure-utils.js";

export const OVERLAYFS_INTERNAL = '.0V3R1ay_';
const DELETED_FILE = OVERLAYFS_INTERNAL+`Deleted.txt`;

const throwNotFound = path => throwDOMException(`The requested entry '${path}' could not be found.`, FSE_NotFound);
const throwInvalidModification = path => throwDOMException(`'${path}' directory is not empty`, 'InvalidModificationError');

const LOWER = false, UPPER = true;

async function mkdirs(node) {
	const parent = node._parent;
	if (!parent._upper) await mkdirs(parent);
	node._upper = await parent._upper.getDirectoryHandle(node._name, CREATE_OPT);
}

/**
 * Recursive delete a directory handle.
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string | string[]} dirPath
 */
const deleteFile = async (rootHandle, dirPath) => {
	const parts = normalizePath(dirPath);
	const name = parts.pop();
	let handle = rootHandle;
	for (const part of parts) {
		handle = await handle.getDirectoryHandle(part);
	}
	await handle.removeEntry(name, RECURSIVE);
	return handle;
};

const existOnly = p => p?.catch(e => {
	if (e.name !== "NotFoundError") throw e;
	// resolve to undefined
});

const dirOnly = p => p.catch(e => {
	if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e;
});

class OverlayFileHandle {
	/** @type {string} */
	#name;
	/** @type {OverlayDirectoryHandle} */
	#parent;
	/** @type {FileSystemFileHandle} */
	#handle;
	/** @type {boolean} */
	#from;
	/**
	 * @param {string} name
	 * @param {OverlayDirectoryHandle} parent
	 * @param {FileSystemFileHandle} handle
	 * @param {boolean} from
	 */
	constructor(name, parent, handle, from) {
		this.#name = name;
		this.#parent = parent;
		this.#handle = handle;
		this.#from = from;
	}

	get kind() { return 'file'; }
	get name() { return this.#name; }

	async getFile() {return this.#handle.getFile();}
	async createWritable(options) {
		const name = this.#name;
		const parent = this.#parent;

		if (this.#from === LOWER) {
			if (!parent._upper) await mkdirs(parent);

			const upperHandle = await parent._upper.getFileHandle(name, CREATE_OPT);
			const oldHandle = this.#handle;
			this.#from = UPPER;
			this.#handle = upperHandle;

			if (options?.keepExistingData) {
				const r = (await oldHandle.getFile()).stream();
				const w = await upperHandle.createWritable();
				try {
					await r.pipeTo(w, { preventClose: true });
				} catch (e) {
					await parent._upper.removeEntry(name).catch(() => {});
					throw e;
				}
				return w;
			}
		}

		return this.#handle.createWritable(options);
	}

	get [Symbol.toStringTag]() { return 'OverlayFileHandle'; }
}

class OverlayDirectoryHandle {
	/**
	 * @param {OverlayFileSystem} root
	 * @param {string} name
	 * @param {string} path
	 * @param {OverlayDirectoryHandle} parent
	 * @param {FileSystemDirectoryHandle} up
	 * @param {FileSystemDirectoryHandle} low
	 */
	constructor(root, path, name, parent, up, low) {
		this._ctx = root;
		this._path = path;
		this._name = name;
		this._parent = parent;
		this._upper = up;
		this._lower = low;
	}

	get kind() { return 'directory'; }

	async getFileHandle(name, options) {
		let origin = UPPER;
		let handle = await existOnly(this._upper?.getFileHandle(name));

		if (!handle) {
			const noCreation = !options?.create;
			const rel = this._path+name;
			if (this._ctx.deleted.has(rel)) {
				if (noCreation) throwNotFound(rel)
			} else {
				try {
					handle = await this._lower?.getFileHandle(name);
					origin = LOWER;
				} catch (e) {
					if (e.name !== "NotFoundError" || noCreation) throw e;
				}
			}

			if (!handle) {
				if (!this._upper) await mkdirs(this);
				handle = await this._upper.getFileHandle(name, options);
			}
		}

		return new OverlayFileHandle(name, this, handle, origin);
	}

	async getDirectoryHandle(name, options) {
		let upper = await existOnly(this._upper?.getDirectoryHandle(name));
		let lower;

		const rel = this._path+name;

		if (!this._ctx.deleted.has(rel)) {
			lower = await existOnly(this._lower?.getDirectoryHandle(name));
		}

		if (!lower && !upper) {
			if (!options?.create) throwNotFound(rel);

			if (!this._upper) await mkdirs(this);
			upper = await this._upper.getDirectoryHandle(name, options);
		}

		return new OverlayDirectoryHandle(this._ctx, rel+'/', name, this, upper, lower);
	}

	async removeEntry(name, options) {
		let upper, lower;

		const up = this._upper, low = this._lower;

		if (up) upper = await dirOnly(up.getDirectoryHandle(name));
		if (low) lower = await dirOnly(low.getDirectoryHandle(name));

		const rel = this._path + name;
		if (!options?.recursive && (upper || lower)) {
			const childView = new OverlayDirectoryHandle(
				this._ctx, rel+'/', name, this, upper, lower
			);
			if (!(await childView.entries().next()).done) {
				throwInvalidModification(rel);
			}
		}

		if (up) await existOnly(up.removeEntry(name, options));

		await this._ctx._delete(rel, !!(upper??lower));
	}

	async *keys() {
		for await (const item of this.entries()) yield item[0];
	}

	async *values() {
		for await (const item of this.entries()) yield item[1];
	}

	async *entries() {
		const upper = this._upper;
		const lower = this._lower;
		const deleted = this._ctx.deleted;
		const path = this._path;

		const items = new Map();

		/**
		 * @param {string} name
		 * @param {FileSystemDirectoryHandle | FileSystemFileHandle} handle
		 * @param {boolean} origin
		 */
		const addItem = (name, handle, origin) => {
			const isFile = handle.kind === 'file';
			let existed = items.get(name);
			if (!existed) items.set(name, existed = [
				name,
				isFile ? new OverlayFileHandle(name, this, handle, origin)
					: new OverlayDirectoryHandle(this._ctx, path+name+'/', name, this)
			]);
			const overlayHandle = existed[1];
			if (overlayHandle.kind === 'directory' && !isFile) {
				overlayHandle[origin ? '_upper' : '_lower'] = handle;
			}
		};

		if (upper) {
			for await (const item of upper) {
				addItem(item[0], item[1], UPPER);
			}
		}
		if (lower && !deleted.has(path.slice(0, -1))) {
			for await (const item of lower) {
				if (!deleted.has(path+item[0]))
					addItem(item[0], item[1], LOWER);
			}
		}

		const sorter = new Intl.Collator();
		const sorted = [...items.values()];
		sorted.sort((a, b) => sorter.compare(a[0], b[0]));

		for (const item of sorted) {
			yield item;
		}
	}

	[Symbol.asyncIterator]() { return this.entries(); }

	get [Symbol.toStringTag]() { return 'OverlayDirectoryHandle'; }
}

class OverlayFileSystem extends OverlayDirectoryHandle {
	#updateDeleted = Promise.resolve();
	/** @type {Set<string>} */
	deleted = new Set();

	constructor(upper, lower) {
		super(null, "", upper?.name || lower?.name || '', null, upper, lower);
		this._ctx = this;
	}

	async _load() {
		let handle;
		try {
			handle = await this._upper.getFileHandle(DELETED_FILE);
		} catch (e) {
			if (e.name !== 'NotFoundError') throw e;
			return;
		}
		const file = await handle.getFile();
		this.deleted = new Set((await file.text()).split('\n').filter(Boolean));
	}

	async _delete(rel, isDir) {
		if (this.deleted.has(rel)) return;

		if (isDir) {
			let noSiblings = rel + '/';
			for (const p of this.deleted) {
				if (p.startsWith(noSiblings)) this.deleted.delete(p);
			}
		}

		this.deleted.add(rel);
		return this.#saveWhiteout();
	}

	#saveWhiteout() {
		return this.#updateDeleted = this.#updateDeleted
			.then(async () => {
				const handle = await this._upper.getFileHandle(DELETED_FILE, CREATE_OPT);
				const writable = await handle.createWritable();
				await writable.write([...this.deleted].join('\n'));
				await writable.close();
			}, () => { /* 上一次失败不影响后续 */ });
	}

	async getFileHandle(name, options) {
		if (name.startsWith(OVERLAYFS_INTERNAL)) throwNotFound(name);
		return super.getFileHandle(name, options);
	}

	async getDirectoryHandle(name, options) {
		if (name.startsWith(OVERLAYFS_INTERNAL)) throwNotFound(name);
		return super.getDirectoryHandle(name, options);
	}

	async removeEntry(name, options) {
		if (name.startsWith(OVERLAYFS_INTERNAL)) throwNotFound(name);
		return super.removeEntry(name, options);
	}

	async *entries() {
		for await (const item of super.entries()) {
			if (item[0].startsWith(OVERLAYFS_INTERNAL)) continue;
			yield item;
		}
	}

	/**
	 * 把 overlay 中的修改提交回 lower。
	 * `options.clean` 为 true 时，提交后清空 upper 中对应部分。
	 * 指定 `options.path` 时只提交该路径的修改，
	 *
	 * @param {{ clean?: boolean, path?: string }} [options]
	 * @returns {Promise<boolean>}
	 */
	async commit({ clean: move, path = '', lower } = {}) {
		if (lower == null) lower = this._lower;
		const upper = this._upper;

		await this.#updateDeleted;

		const parts = normalizePath(path);
		const prefix = parts.join('/');
		const dirPrefix = prefix+'/';

		const deleted = this.deleted;
		let whiteoutChanged = false;
		let changed = false;

		const [enqueue, flush] = createAsyncQueue(100);

		if (!prefix) {
			whiteoutChanged = deleted.size > 0;
			for (const item of deleted) {
				await enqueue(() => existOnly(deleteFile(lower, item)));
			}
			deleted.clear();

			for await (const item of upper) {
				if (!item[0].startsWith(OVERLAYFS_INTERNAL)) {
					await copyEntry(item[1], lower, item[0], move);
					changed = true;
				}
				if (move) await upper.removeEntry(item[0], RECURSIVE);
			}
		} else {
			for (const item of deleted) {
				if (item !== prefix && !item.startsWith(dirPrefix)) continue;

				// 被删除的文件在 lower 中可能已不存在
				await enqueue(() => existOnly(deleteFile(lower, item)));

				if (move) {
					deleted.delete(item);
					whiteoutChanged = true;
				}
			}

			const name = parts.pop();
			const upperParent = await existOnly(resolveDirectory(upper, parts));

			if (upperParent) {
				let handle = await dirOnly(upperParent.getDirectoryHandle(name)) ?? await existOnly(upperParent.getFileHandle(name));

				if (handle) {
					const lowerParent = await resolveDirectory(lower, parts, CREATE_OPT);
					await copyEntry(handle, lowerParent, name, move);
					changed = true;
					if (move) await upperParent.removeEntry(name, RECURSIVE);
				}
			}
		}

		await flush();
		if (whiteoutChanged) await this.#saveWhiteout();

		return !!(changed|whiteoutChanged);
	}

	/**
	 * 撤销 overlay 中的修改
	 * @param {string} path
	 * @return {Promise<boolean>}
	 */
	async revert(path = '') {
		let normPath = normalizePath(path).join('/');
		let changed = 0;
		const deleted = this.deleted;

		// 撤销所有修改
		if (!normPath) {
			changed |= deleted.size > 0;
			deleted.clear();

			const upper = this._upper;
			for await (const item of upper) {
				await upper.removeEntry(item[0], RECURSIVE);
				changed = 1;
			}
		} else {
			const handle = await existOnly(deleteFile(this, path));
			if (handle) changed = 1;

			changed |= deleted.delete(normPath);

			normPath += '/';

			for (let path of deleted) {
				if (path.startsWith(normPath))
					changed |= deleted.delete(path);
			}
		}

		await this.#saveWhiteout();

		return !!changed;
	}
}

/**
 * 创建 overlay 文件系统视图。
 *
 * @param {FileSystemDirectoryHandle} upper 可写暂存层
 * @param {FileSystemDirectoryHandle} lower 只读基础层
 * @returns {Promise<OverlayFileSystem>} 模拟的合并目录句柄
 */
export const createOverlayFileSystem = async (upper, lower) => {
	const handle = new OverlayFileSystem(upper, lower);
	await handle._load();
	return handle;
};