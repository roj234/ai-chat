import {readAsString} from "/common/chardet.js";
import {createTextFileEditHelper} from "/common/fs-common.js";
import {ACL, FSE_NotFound, LIST, READ, throwDOMException, WRITE} from "/common/ACL.js";
import {formatSize} from "unconscious/common/Utils.js";
import {AS_IS, UTF8_TEXT_ENCODER} from "unconscious";
import {
	copyEntry,
	CREATE,
	CREATE_LEAF,
	CREATE_OPT,
	RECURSIVE,
	REQUIRE_DIR,
	REQUIRE_FILE,
	resolveHandle
} from "./WebFSUtils.js";
import {createOverlayFileSystem, OVERLAYFS_INTERNAL} from "./OverlayFileSystem.js";
import {compileGlobPattern, emptyAsyncGenerator, generateGlobCode, parseGlobPattern} from "/common/fs-glob.js";
// noinspection ES6UnusedImports
import {mpscScheduler} from "/common/pure-utils.js";
import {
	VCS_BASE_BRANCH,
	VCS_COMMIT,
	VCS_DELETE_BRANCH,
	VCS_DIFF,
	VCS_LIST_BRANCHES,
	VCS_QUERY,
	VCS_REVERT,
	VCS_SWITCH
} from "./VCS_shared.js";
import {showToast} from "../../src/components/Toast.js";
import {prettyError} from "../../src/utils/utils.js";

/**
 * @template T
 * @param {Promise<T>} promise
 * @return {Promise<T>}
 */
const EAT = promise => promise.catch(() => {});
const FILE_TOO_BIG = "InvalidStateError";
const toArrayBuffer = data => (typeof data === "string" ? UTF8_TEXT_ENCODER.encode(data) : data).buffer;
const prependLF = data => {
	if (typeof data === 'string') return '\n' + data;
	const newBuffer = new Uint8Array(data.length + 1);
	data[0] = 0x0a;
	newBuffer.set(data, 1);
	return data;
};

async function readFileText(rootHandle, path) {
	const fileHandle = (await resolveHandle(rootHandle, path, READ | REQUIRE_FILE))[2];
	const file = await fileHandle.getFile();
	return await file.text();
}

/**
 * Walk the filesystem matching a glob pattern.
 * Yields { name, relDir, handle } where handle is the FileSystemHandle.
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string} pattern
 * @param {string} path
 * @param {boolean} [showHidden=false]
 * @param {ACL} [acl]
 * @param {string[]} [exclude]
 * @return {Promise<AsyncGenerator<[name: string, relDir: string, handle: FileSystemDirectoryHandle | FileSystemFileHandle]>>}
 */
const glob = async (rootHandle, pattern, path, showHidden, acl, exclude) => {
	const result = compileGlobPattern(pattern, path, exclude);
	let handle;
	try {
		handle = (await resolveHandle(rootHandle, result.path, READ|LIST|REQUIRE_DIR, acl))[2];
	} catch (e) {
		if (e.name === FSE_NotFound)
			return emptyAsyncGenerator();
		throw e;
	}

	// Don't worry, it is handled by Vite
	return eval(generateGlobCode(false));
};

/**
 *
 * @param {FileSystemDirectoryHandle | OverlayFileSystem} rootHandle
 * @param {Partial<AiChat.Mount>} config
 * @returns {Promise<AiChat.FileSystemInstance>}
 */
export const createWebFileSystem = async (rootHandle, config = {}) => {
	const realHandle = rootHandle;

	/** @type {ACL} */
	let acl;
	const loadACL = async () => {
		let ignoreText = config.fs_ACL?.ignore;
		if (ignoreText) {
			ignoreText = await readFileText(realHandle, ignoreText);
		} else {
			for (const name of ['.ignore', '.gitignore']) {
				try {
					const fileHandle = await realHandle.getFileHandle(name);
					const file = await fileHandle.getFile();
					ignoreText = await file.text();
					break;
				} catch {}
			}
		}

		let aclText = config.fs_ACL?.acl;
		if (aclText) {
			aclText = await readFileText(realHandle, aclText);
		}

		acl = new ACL();
		if (aclText) acl.parseRule(aclText);
		if (ignoreText) acl.parseIgnore(ignoreText);
		acl.compile();
	};
	const myResolveHandle = (path, flags) => resolveHandle(rootHandle, path, flags, acl);

	const api = {
		async mkdir({path}) {
			await myResolveHandle(path, WRITE|CREATE|REQUIRE_DIR|CREATE_LEAF);
			return 'Success';
		},

		async copy({ src, dest, move }) {
			const [ srcParent, srcName, srcHandle ] = await myResolveHandle(src, move ? READ | WRITE : READ);
			const [ destParent, destName ] = await myResolveHandle(dest, WRITE | CREATE | (srcHandle.kind === "file" ? REQUIRE_FILE : REQUIRE_DIR));

			await copyEntry(srcHandle, destParent, destName, move);
			if (move) await EAT(srcParent.removeEntry(srcName, RECURSIVE));

			return 'Success';
		},

		async stat({path}) {
			const [ parent, name, handle, isDir ] = await myResolveHandle(path, READ);

			const file = isDir ? null : await handle.getFile();
			let str = `type: ${(isDir ? 'dir' : 'file')}`;
			if (file) {
				str += `
size: ${file.size}
mtime: ${new Date(file.lastModified).toISOString()}`
			}
			return str;
		},

		async delete({path}) {
			const [ parent, name, handle ] = await myResolveHandle(path, WRITE);
			await parent.removeEntry(name, RECURSIVE);
			return 'Success';
		},

		/**
		 * Append content to a file, optionally ensuring a newline precedes the content
		 * if the existing file doesn't end with one.
		 *
		 * @param {FileSystemDirectoryHandle} rootHandle
		 * @param {string} path
		 * @param {string|Uint8Array} content
		 */
		async append({path, content, newline = true}) {
			const [parentHandle, name, fileHandle] = await myResolveHandle(path, WRITE | CREATE | REQUIRE_FILE);

			if (fileHandle.createSyncAccessHandle) {
				const raf = await fileHandle.createSyncAccessHandle();
				const size = raf.getSize();

				try {
					if (newline && size > 0) {
						const offset = size - 1;
						const lastByte = new Uint8Array(1);
						raf.read(lastByte.buffer, {at: offset});
						const needNewline = lastByte[0] !== 0x0a;
						if (needNewline) content = prependLF(content);
					}

					raf.write(toArrayBuffer(content), { at: size });
				} finally {
					raf.close();
				}
			} else {
				for (;;) {
					const file = await fileHandle.getFile();
					const size = file.size;

					// Check whether existing content ends with \n
					if (newline && size > 0) {
						const offset = size - 1;
						const lastByte = new Uint8Array((await file.slice(offset, offset + 1).arrayBuffer()))[0];
						const needNewline = lastByte !== 0x0a;
						if (needNewline) content = prependLF(content);
					}

					const writable = await fileHandle.createWritable({ keepExistingData: true });
					await writable.seek(size);
					await writable.write(content);

					try {
						await writable.close();
						break;
					} catch (e) {
						if (e.name === FILE_TOO_BIG) {
							const data = new Blob([file, content]);
							content = new Uint8Array(await data.arrayBuffer());
							await parentHandle.removeEntry(name);
							await parentHandle.getFileHandle(name, CREATE_OPT);
						}
					}
				}
			}

			teh.del(path);
			if (/^\.(gitignore|ignore)$/.test(path)) await loadACL();
			return 'Success';
		},

		/** List directory, optionally with a glob filter */
		async list({
			path = '.',
			pattern,
			json = false,
			limit = 500,
			modifiedSince = 0,
			showDir = null,
			showModified = false,
			exclude = [],
			showHidden
		}) {
			pattern = pattern || '*';
			// 行为一致，顺便给AI擦屁股
			if (pattern.startsWith("*.") && !pattern.includes('/')) pattern = "**/"+pattern;

			if (null == showHidden) showHidden = /(?:^|\/)\.[^./]/.test(pattern);

			const entries = await glob(rootHandle, pattern, path, showHidden, acl, exclude);

			let prefix = '';
			let modSince = modifiedSince ? +new Date(modifiedSince) : 0;
			if (!isFinite(modSince)) throw 'Invalid date';

			const result = [];

			for await (const [name, handle, relDir] of entries) {
				const displayPath = relDir ? relDir + '/' + name : name;

				if (!json && result.length >= limit) {
					prefix = `[TRUNCATED to ${limit} entries, use a more specific path or pattern]\n`;
					break;
				}

				if (handle.kind === 'file') {
					const file = await handle.getFile();
					if (file.lastModified > modSince) {
						const item = [displayPath, "file", json ? file.size : formatSize(file.size)];
						if (showModified || modSince) item.push(json ? file.lastModified : new Date(file.lastModified).toISOString().slice(0, -5)+'Z');
						result.push(item);
					}
				} else if ((showDir != null ? showDir : !modSince)) {
					const ignore = acl.denyList(displayPath, true);
					result.push([displayPath, ignore === 'skip' ? "dir (descents skipped)" : "dir"]);
				}
			}

			if (modSince) result.sort((a, b) => b[3] - a[3]);

			if (json) return result;
			return result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]";
		}
	};

	/** Resolve a File from a path relative to root handle */
	const resolveFile = async path => {
		const data = await myResolveHandle(path, READ | REQUIRE_FILE);
		const fileHandle = data[2];
		return await fileHandle.getFile();
	};

	const fsCommonApi = {
		list: api.list,
		absPath: AS_IS,
		/**
		 * @param {string} path
		 * @returns {Promise<string>}
		 */
		read: async(path) => readAsString(await resolveFile(path)),
		/**
		 * @param {string} path
		 * @param {string|Uint8Array} data
		 * @param [_ctx]
		 * @param {1} [_overwrite]
		 * @returns {Promise<void>}
		 */
		async write(path, data, _ctx, _overwrite) {
			const [ parent, name, handle ] = await myResolveHandle(path, WRITE | CREATE | REQUIRE_FILE);

			if (handle) try {
				await parent.removeEntry(name);
			} catch (e) {
				if (e.name === FILE_TOO_BIG) throw "Failed to write file, it might locked by user.";
				if (e.name === "NoModificationAllowedError") throwDOMException("Write file in parallel", "ConcurrentModificationError");
				throw e;
			}

			const fileHandle = await parent.getFileHandle(name, CREATE_OPT);
			const writable = await fileHandle.createWritable();
			await writable.write(data);
			await writable.close();

			if (/^\.(gitignore|ignore)$/.test(path)) await loadACL();
		},
		/**
		 * @param {string} path
		 * @returns {Promise<number>}
		 */
		async mtime(path) {
			const file = await resolveFile(path);
			return file.lastModified;
		}
	};
	const teh = createTextFileEditHelper(fsCommonApi);

	let branch = config.fs_branch;

	async function enableOverlay() {
		if (realHandle === rootHandle) {
			const upper = await rootHandle.getDirectoryHandle(OVERLAYFS_INTERNAL+branch, CREATE_OPT);
			config.fs_branch = branch;
			rootHandle = await createOverlayFileSystem(upper, rootHandle);
		}
	}
	async function disableOverlay() {
		if (realHandle !== rootHandle) {
			delete config.fs_branch;
			branch = null;
			rootHandle = realHandle;
		}
	}

	await loadACL().catch(e => {
		acl = new ACL();
		acl.parseRule("-rwl *\n+rl /\n+rw /.acl");
		acl.compile();
		showToast("ACL初始化失败\n"+prettyError(e), "error");
	});
	if (branch) await enableOverlay();

	return {
		...api,
		...teh,
		open: async ({ path, create }) => (await myResolveHandle(path, READ | WRITE | REQUIRE_FILE | (create * (CREATE|CREATE_LEAF))))[2],
		readRaw: ({path}) => resolveFile(path),
		writeRaw: ({path, content}) => fsCommonApi.write(path, content, null, 1).then(() => teh.del(path)),
		appendRaw: api.append,

		vcs: async ({mode, path, limit, target, json}) => {
			if (mode === VCS_QUERY) {
				if (path) {
					const baseHandle = (await resolveHandle(realHandle, path, READ | REQUIRE_FILE).catch(() => {}))?.[2];
					const overlayHandle = (await resolveHandle(rootHandle, path, READ | REQUIRE_FILE).catch(() => {}))?.[2];
					return [baseHandle && await baseHandle.getFile(), overlayHandle && await overlayHandle.getFile()];
				}

				return branch;
			}
			if (mode === VCS_LIST_BRANCHES) {
				if (json) {
					const list = [];
					for await (const [name, h] of realHandle) {
						if (name.startsWith(OVERLAYFS_INTERNAL) && h.kind === "directory") {
							list.push(name.slice(OVERLAYFS_INTERNAL.length));
						}
					}
					return list;
				}

				let s = (branch == null ? '* ' : '  ')+VCS_BASE_BRANCH;
				for await (const [name, h] of realHandle) {
					if (name.startsWith(OVERLAYFS_INTERNAL) && h.kind === "directory") {
						const branchName = name.slice(OVERLAYFS_INTERNAL.length);
						s += '\n' + (branchName === branch ? '* ' : '  ') + branchName;
					}
				}
				return s;
			}

			if (mode === VCS_DELETE_BRANCH) {
				if (branch === path) await disableOverlay();
				await realHandle.removeEntry(OVERLAYFS_INTERNAL+path, RECURSIVE);
				return 'Success';
			}

			if (mode === VCS_SWITCH) {
				if (/[\x00-\x1F\x7F|<>"*?:\\/]/.test(path)) throw new Error("Illegal character in branch name");

				await disableOverlay();

				if (path !== VCS_BASE_BRANCH) {
					branch = path;
					await enableOverlay();
				}

				return;
			}

			// 这会在Files的systemPrompt函数中调用
			if (branch && realHandle === rootHandle) {
				let p = enableOverlay();
				if (mode == null) return p;
				await p;
			}

			if (!branch) return json?[]:`No overlay active.`;

			if (mode === VCS_DIFF) {
				const acl1 = new ACL();
				acl1.parseRule(`-rw .0V3R1ay_Deleted.txt`);
				acl1.compile();

				const entries = await glob(rootHandle._upper, path, "", true, acl1);
				const pattern = new RegExp("^"+parseGlobPattern(path, true), 'ui');

				let prefix = '';

				const deleted = new Set;

				for (let path of rootHandle.deleted) {
					if (pattern.test(path)) deleted.add(path);
				}

				const result = [];

				for await (const [name, handle, relDir] of entries) {
					let displayPath = relDir ? relDir + '/' + name : name;

					if (result.length >= limit) {
						prefix = `[TRUNCATED to ${limit} entries, use a more specific path or pattern]\n`;
						break;
					}

					deleted.delete(displayPath);
					if (handle.kind === 'file') {
						const file = await handle.getFile();
						const h = await resolveHandle(realHandle, displayPath, 0).catch(e => {});
						const item = [h ? "modify" : "add", displayPath];
						item.push(new Date(file.lastModified).toISOString().slice(0, -5)+'Z');
						result.push(item);
					} else {
						deleted.delete(displayPath+'/');
						result.push(["dir", displayPath]);
					}
				}

				result.sort((a, b) => b[2] - a[2]);

				for (let path of deleted) {
					const handle = await resolveHandle(realHandle, path, 0).catch(e => {});
					if (handle) result.push(["del", path]);
				}

				if (json) return result;

				return result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]";
			}

			if (mode === VCS_COMMIT || mode === VCS_REVERT) {
				if (mode === VCS_COMMIT) {
					let targetFS;
					if (target && target !== VCS_BASE_BRANCH) {
						if (target === branch) throw "Commit 目标不能是当前暂存区.";
						targetFS = await createOverlayFileSystem(await realHandle.getDirectoryHandle(OVERLAYFS_INTERNAL+target), realHandle);
					}
					const changed = await rootHandle.commit({ clean: true, path, lower: targetFS });
					if (!changed) return "Nothing to commit";
				} else {
					const changed = await rootHandle.revert(path);
					if (!changed) return "Nothing to revert";
				}

				return 'Success';
			}

			// should not reach here
		}
	};
};