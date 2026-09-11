/**
 * Overlay (Copy-on-Write) File System in Chrome
 */
import {normalizePath} from "unconscious/common/path-utils.js";
import {copyEntry, CREATE_OPT, RECURSIVE, resolveDirectory, resolveHandle} from "./WebFSUtils.js";
import {createAsyncQueue, FSE_NotFound, throwDOMException} from "/common/pure-utils.js";

export const OVERLAYFS_INTERNAL = '.0V_';
const isInternal = name => name.startsWith(OVERLAYFS_INTERNAL);
const DELETED_FILE = OVERLAYFS_INTERNAL+`Whiteout.log`;

const throwNotFound = path => throwDOMException(`The requested entry '${path}' could not be found.`, FSE_NotFound);
const throwInvalidModification = path => throwDOMException(`'${path}' directory is not empty`, 'InvalidModificationError');
const typeError = other => new TypeError(`isSameEntry() expects a FileSystemHandle, but got ${other === null ? 'null' : typeof other}`);

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

/**
 * @param {(FileSystemHandle | undefined)[]} candidates
 * @param {(FileSystemHandle | undefined)[]} targets
 * @returns {Promise<boolean>}
 */
const matchesReal = async (candidates, targets) => {
	for (const a of candidates) {
		if (!a) continue;
		for (const b of targets) {
			if (!b) continue;
			if (a === b || await a.isSameEntry(b)) return true;
		}
	}
	return false;
};

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

	/**
	 * @param {FileSystemHandle} other
	 * @returns {Promise<boolean>}
	 */
	/*async isSameEntry(other) {
		if (this === other) return true;
		if (other instanceof OverlayFileHandle) {
			const parent = this.#parent, otherParent = other.#parent;
			if (parent._fs === otherParent._fs)
				return parent._path === otherParent._path && this.#name === other.#name;
			other = other.#handle;
		}
		return this.#handle.isSameEntry(other);
	}*/

	/**
	 * @param {FileSystemDirectoryHandle} destDir
	 * @param {string} destName
	 */
	async move(destDir, destName) {
		if (destDir instanceof OverlayDirectoryHandle) {
			if (!destDir._upper) await mkdirs(destDir);
			destDir = destDir._upper;
		}

		if (this.#from !== UPPER) {
			const r = (await this.#handle.getFile()).stream();
			const w = await (await destDir.getFileHandle(destName, CREATE_OPT)).createWritable();
			try {
				await r.pipeTo(w);
			} catch (e) {
				await destDir.removeEntry(destName).catch(() => {});
				throw e;
			}
			await this.#parent._fs._delete(this.#parent._path + this.#name, false);

			return
		}

		await this.#handle.move(destDir, destName);
		//this.#name = destName;
		//this.#parent = destDir;
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
		this._fs = root;
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
			if (this._fs.deleted.has(rel)) {
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

		if (!this._fs.deleted.has(rel)) {
			lower = await existOnly(this._lower?.getDirectoryHandle(name));
		}

		if (!lower && !upper) {
			if (!options?.create) throwNotFound(rel);

			if (!this._upper) await mkdirs(this);
			upper = await this._upper.getDirectoryHandle(name, options);
		}

		return new OverlayDirectoryHandle(this._fs, rel+'/', name, this, upper, lower);
	}

	/**
	 * @param {FileSystemHandle} other
	 * @returns {Promise<boolean>}
	 */
	/*async isSameEntry(other) {
		if (this === other) return true;
		if (typeof other?.isSameEntry !== 'function') throw typeError(other);
		if (other.kind !== 'directory') return false;

		if (other instanceof OverlayDirectoryHandle) {
			if (this._fs && this._fs === other._fs) return this._path === other._path;
			return matchesReal([this._upper, this._lower], [other._upper, other._lower]);
		}
		return matchesReal([this._upper, this._lower], [other]);
	}*/

	async removeEntry(name, options) {
		let upper, lower;

		const up = this._upper, low = this._lower;

		if (up) upper = await dirOnly(up.getDirectoryHandle(name));
		if (low) lower = await dirOnly(low.getDirectoryHandle(name));

		const rel = this._path + name;
		if (!options?.recursive && (upper || lower)) {
			const childView = new OverlayDirectoryHandle(
				this._fs, rel+'/', name, this, upper, lower
			);
			if (!(await childView.entries().next()).done) {
				throwInvalidModification(rel);
			}
		}

		if (up) await existOnly(up.removeEntry(name, options));

		await this._fs._delete(rel, !!(upper??lower));
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
		const deleted = this._fs.deleted;
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
					: new OverlayDirectoryHandle(this._fs, path+name+'/', name, this)
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
		this._fs = this;
	}

	async _load() {
		const handle = await existOnly(this._upper.getFileHandle(DELETED_FILE));
		if (!handle) return;
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
	 * 创建 commit 的逆操作 —— 把 preimage 当作 upper，覆盖在提交之后的 base 上即可复原。
	 * @param {FileSystemDirectoryHandle} preimage
	 * @param {FileSystemDirectoryHandle} [lower]
	 * @returns {Promise<boolean>}
	 */
	async backup(preimage, {lower} = {}) {
		if (lower == null) lower = this._lower;
		const upper = this._upper;

		/** @type {Set<string>} */
		const deleted = new Set();

		const [enqueue, flush] = createAsyncQueue(100);

		for (const item of this.deleted) {
			await enqueue(async () => {
				const path = normalizePath(item);
				const handle = await existOnly(resolveHandle(lower, path, 0));
				if (!handle) return;

				const dest = await resolveDirectory(preimage, path.slice(0, -1), CREATE_OPT);
				await copyEntry(handle[2], dest, path.at(-1), false);
				if (/* isDir */handle[3]) deleted.add(item);
			});
		}

		const catcher = e => {
			if (e.name !== 'NotFoundError' && e.name !== 'TypeMismatchError') throw e;
		};

		/**
		 * @param {FileSystemHandle} upHandle
		 * @param {FileSystemHandle | undefined} lowHandle
		 * @param {string} relPath
		 */
		async function diff(upHandle, lowHandle, relPath) {
			if (!lowHandle) { deleted.add(relPath); return; }

			if (upHandle.kind === 'file') {
				const idx = relPath.lastIndexOf('/');
				const parent = idx < 0 ? '' : relPath.slice(0, idx);
				const dest = await resolveDirectory(preimage, parent, CREATE_OPT);
				await copyEntry(lowHandle, dest, relPath.slice(idx + 1), false);
			} else {
				for await (const [name, child] of upHandle) {
					const lowChild = await lower[child.kind === 'file' ? "getFileHandle" : "getDirectoryHandle"](name).catch(catcher);
					await diff(child, lowChild, relPath+'/'+name);
				}
			}
		}

		for await (const [name, upHandle] of upper) {
			if (isInternal(name)) continue;
			const lowHandle = await lower[upHandle.kind === 'file' ? "getFileHandle" : "getDirectoryHandle"](name).catch(catcher);
			await diff(upHandle, lowHandle, name);
		}

		await flush();

		let fileCount = 0;
		try {
			const file = await (await preimage.getFileHandle(DELETED_FILE)).getFile();
			for (const p of (await file.text()).split('\n')) {
				if (p) {
					fileCount ++;
					deleted.add(p);
				}
			}
		} catch (e) {
			if (e.name !== 'NotFoundError') throw e;
		}

		if (fileCount !== deleted.size) {
			const writable = await (await preimage.getFileHandle(DELETED_FILE, CREATE_OPT)).createWritable();
			await writable.write([...deleted].join('\n'));
			await writable.close();
		}
	}

	/**
	 * 把 upper 中的修改提交回 lower。
	 * `options.clean` 为 true 时，提交后清空 upper。
	 * 返回 lower 是否被真实修改
	 *
	 * @param {{
	 *   clean?: boolean,
	 *   lower?: FileSystemDirectoryHandle,
	 * }} [options]
	 * @returns {Promise<boolean>}
	 */
	async commit({ clean: move, lower } = {}) {
		if (lower == null) lower = this._lower;
		const upper = this._upper;

		const deleted = this.deleted;
		let changed = false;
		const onfulfilled = () => changed = true;

		const [enqueue, flush] = createAsyncQueue(100);

		for (const item of deleted) {
			await enqueue(() => existOnly(deleteFile(lower, item).then(onfulfilled)));
		}

		await this.#updateDeleted;

		for await (const [name, handle] of upper) {
			if (!isInternal(name)) {
				await copyEntry(handle, lower, name, move);
				changed = true;
			}
			if (move) await upper.removeEntry(name, RECURSIVE);
		}

		await flush();
		if (move && deleted.size) {
			deleted.clear();
			await this.#saveWhiteout();
		}

		return changed;
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