import {ACL, FSE_IsDir, FSE_NotFound, LIST, READ, throwDOMException, WRITE} from "/common/ACL.js";
import {normalizePath} from "unconscious/common/path-utils.js";

// ────────────────────────────────── FileSystem Helpers ──────────────────────────────────

export const CREATE_OPT = { create: true };
export const RECURSIVE = { recursive: true };

export const REQUIRE_FILE = 1 << 3, REQUIRE_DIR = 1 << 4, CREATE = 1 << 5, CREATE_LEAF = 1 << 6;

/**
 * Resolve parent directory handle and entry name from a full path (relative to root).
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string} filePath
 * @param {number} flags
 * @param {ACL} [acl]
 * @return {Promise<[ FileSystemDirectoryHandle, string, FileSystemDirectoryHandle | FileSystemFileHandle, boolean ]>}
 */
export const resolveHandle = async (rootHandle, filePath, flags, acl) => {
	const parts = normalizePath(filePath);
	if (!parts.length) {
		if (flags&REQUIRE_FILE) throwDOMException("illegal operation on a directory", FSE_IsDir);
		acl?.denyThrow([], true, flags&(READ|WRITE|LIST));
		return [,, rootHandle, true];
	}

	const name = parts.pop();
	const options = flags&CREATE ? CREATE_OPT : undefined;

	let parent = rootHandle;
	let i = 0;
	const len = parts.length;

	try {
		for (; i < len; i++) {
			parent = await parent.getDirectoryHandle(parts[i], acl?.deny(parts.slice(0, i), true, WRITE) ? undefined : options);
		}
	} catch (e) {
		if (e.name === FSE_NotFound) {
			acl?.denyThrow(parts.slice(0, i), true, READ);
			throwDOMException("No such directory, open "+JSON.stringify(parts.slice(0, i+1).join('/')), FSE_NotFound);
		}
		throw e;
	}
	parts.push(name);

	const isRequired = flags & (REQUIRE_DIR | REQUIRE_FILE);
	try {
		let handle, isDir;

		if (!isRequired) {
			try {
				handle = await parent.getFileHandle(name);
				isDir = false;
			} catch (e) {
				if (e.name === FSE_NotFound) throw e;
				handle = await parent.getDirectoryHandle(name);
				isDir = true;
			}

			acl?.denyThrow(parts, isDir, flags&(READ|WRITE|LIST));
		} else {
			isDir = !(flags & REQUIRE_FILE);
			acl?.denyThrow(parts, isDir, flags&(READ|WRITE|LIST));

			const options = flags&CREATE_LEAF ? CREATE_OPT : undefined;
			let p = isDir ? parent.getDirectoryHandle(name, options) : parent.getFileHandle(name, options);
			if (flags&(WRITE|CREATE_LEAF)) p = p.catch(e => {
				if (e.name !== FSE_NotFound) throw e;
			});
			handle = await p;
		}

		return [parent, name, handle, isDir];
	} catch (e) {
		if (e.name === FSE_IsDir)
			throwDOMException(`illegal operation on a ${isRequired&REQUIRE_FILE ? 'directory' : 'file'}`, FSE_IsDir);
		if (e.name === FSE_NotFound)
			throwDOMException(`No such ${isRequired === 0 ? 'file or directory' : (isRequired&REQUIRE_FILE) ? 'file':'directory'}, open `+JSON.stringify(parts.join('/')), FSE_NotFound);
		throw e;
	}
};

/**
 * Resolve a directory handle from a path.
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string | string[]} dirPath
 * @param {{ create: true }} [options]
 */
export const resolveDirectory = async (rootHandle, dirPath, options) => {
	const parts = normalizePath(dirPath);
	let handle = rootHandle;
	try {
		for (const part of parts) {
			handle = await handle.getDirectoryHandle(part, options);
		}
	} catch (e) {
		throw typeof e === 'string' ? e : throwDOMException("Directory "+parts.join('/')+" not found", FSE_NotFound);
	}
	return handle;
};

/**
 *
 * @param {FileSystemDirectoryHandle | FileSystemFileHandle} handle
 * @param {FileSystemDirectoryHandle} destDir
 * @param {string} destName
 * @param {boolean} move
 * @return {Promise<void>}
 */
export const copyEntry = async (handle, destDir, destName, move) => {
	if (handle.kind === 'file') {
		if (move && typeof handle.move === 'function') {
			// destParent already resolved with MKDIRS, no need for manual mkdirs
			try {
				await handle.move(destDir._upper ?? destDir, destName);
				return;
			} catch {}
		}
		const file = await handle.getFile();
		const newHandle = await destDir.getFileHandle(destName, CREATE_OPT);
		const writable = await newHandle.createWritable();
		await writable.write(file);
		await writable.close();
	} else {
		const newDir = await destDir.getDirectoryHandle(destName, CREATE_OPT);
		const promises = [];
		for await (const [name, h] of handle) {
			promises.push(copyEntry(h, newDir, name, move));
		}
		await Promise.all(promises);
	}
};
