import {readAsString} from "/common/chardet.js";
import {compileGlobPattern, createTextFileEditHelper} from "/common/fs-common.js";
import {IGNORED_ERROR_MESSAGE, IgnoreMatcher} from "/common/ignore.js";
import {normalizePath} from "unconscious/common/path-utils.js";
import {formatSize} from "unconscious/common/Utils.js";
import {AS_IS, UTF8_TEXT_ENCODER} from "unconscious";

// ────────────────────────────────── FileSystem Helpers ──────────────────────────────────

export const CREATE = { create: true };
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

/**
 * Resolve parent directory handle and entry name from a full path (relative to root).
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {string} filePath
 * @param {{ create: true }} [options]
 */
const resolveParent = async (rootHandle, filePath, options) => {
	const parts = normalizePath(filePath);
	const name = parts.pop();
	let parent = rootHandle;
	try {
		for (const part of parts) {
			parent = await parent.getDirectoryHandle(part, options);
		}
	} catch (e) {
		throw typeof e === 'string' ? e : ("Directory "+parts.join('/')+" not found");
	}
	return [ parent, name ];
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
		throw typeof e === 'string' ? e : ("Directory "+parts.join('/')+" not found");
	}
	return handle;
};

/**
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {Partial<AiChat.AgentFSPreset>} config
 * @returns {{
 * 		mkdir({path: string}): Promise<string>,
 * 		copy({src: string, dest: string, move?: boolean}): Promise<string>,
 * 		stat({path: string}): Promise<string>,
 * 		delete({path: string}): Promise<string>,
 * 		list({path: string, glob?: string}): Promise<string>,
 * }}
 */
export const createWebFileSystem = (rootHandle, config) => {
	/** @type {IgnoreMatcher} */
	let ignored;
	const loadIgnore = async () => {
		if ((ignored = config.fs_ACL)) return;
		let text = '';

		for (const name of ['.ignore', '.gitignore']) {
			try {
				const fileHandle = await rootHandle.getFileHandle(name);
				const file = await fileHandle.getFile();
				text = await file.text();
				break;
			} catch {}
		}
		ignored = new IgnoreMatcher();
		ignored.parse(text);
		ignored.compile();
	};
	const checkPath = async (path, isDir) => {
		if (!ignored) await loadIgnore();
		const parsedPath = normalizePath(path);
		if (ignored.test(parsedPath.join('/'), isDir)) throw IGNORED_ERROR_MESSAGE;
	};

	/**
	 *
	 * @param {FileSystemDirectoryHandle | FileSystemFileHandle} handle
	 * @param {FileSystemDirectoryHandle} destDir
	 * @param {string} destName
	 * @param {boolean} move
	 * @return {Promise<void>}
	 */
	async function copyEntry(handle, destDir, destName, move) {
		if (handle.kind === 'file') {
			if (move && typeof handle.move === 'function') {
				// destParent already resolved with MKDIRS, no need for manual mkdirs
				await handle.move(destDir, destName);
			} else {
				const file = await handle.getFile();
				const newHandle = await destDir.getFileHandle(destName, CREATE);
				const writable = await newHandle.createWritable();
				await writable.write(file);
				await writable.close();
			}
		} else {
			const newDir = await destDir.getDirectoryHandle(destName, CREATE);
			const promises = [];
			for await (const [childName, childHandle] of handle.entries()) {
				promises.push(copyEntry(childHandle, newDir, childName, move));
			}
			await Promise.all(promises);
		}
	}

	const api = {
		async mkdir({path}) {
			await checkPath(path, true);
			await resolveDirectory(rootHandle, path, CREATE);
			return 'Success';
		},

		async copy({ src, dest, move }) {
			if (move) await checkPath(src, true);
			await checkPath(dest, true);
			const [ srcParent, srcName ] = await resolveParent(rootHandle, src);
			const [ destParent, destName ] = await resolveParent(rootHandle, dest, CREATE);

			let srcHandle;
			try { srcHandle = await srcParent.getFileHandle(srcName); }
			catch { srcHandle = await srcParent.getDirectoryHandle(srcName); }

			await copyEntry(srcHandle, destParent, destName, move);
			if (move) await EAT(srcParent.removeEntry(srcName, { recursive: true }));

			return 'Success';
		},

		async stat({path}) {
			const [ parent, name ] = await resolveParent(rootHandle, path);

			let handle;
			if (null == name) handle = parent;
			else try {
				handle = await parent.getFileHandle(name);
			} catch {
				try {
					handle = await parent.getDirectoryHandle(name);
				} catch {
					throw new Error(`Path not found: ${path}`);
				}
			}
			const isFile = handle.kind === 'file';
			const file = isFile ? await handle.getFile() : null;
			let str = `type: ${isFile ? 'file' : 'dir'}`;
			if (file) {
				str += `
size: ${file.size}
mtime: ${new Date(file.lastModified).toISOString()}`
			}
			return str;
		},

		async delete({path}) {
			await checkPath(path, true);
			const [ parent, name ] = await resolveParent(rootHandle, path);
			if (config.fs_trashCan) {
				let handle;
				let isDir;
				try {
					handle = await parent.getFileHandle(name);
				} catch (e) {
					handle = await parent.getDirectoryHandle(name);
					isDir = true;
				}

				await copyEntry(handle, await rootHandle.getDirectoryHandle(".trash", CREATE), Date.now()+"_"+name, true);
				await EAT(parent.removeEntry(name, { recursive: true }));
			} else {
				await parent.removeEntry(name, { recursive: true });
			}
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
			await checkPath(path);
			const [parentHandle, name] = await resolveParent(rootHandle, path, CREATE);
			const fileHandle = await parentHandle.getFileHandle(name, CREATE);
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
							await parentHandle.getFileHandle(name, CREATE);
						}
					}
				}
			}

			if (/\.(gitignore|ignore)$/.test(path)) await loadIgnore();
			teh.del(path);          // invalidate text line cache
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
			showHidden = false
		}) {
			if (!ignored) await loadIgnore();

			pattern = pattern || '*';
			// 行为一致，顺便给AI擦屁股
			if (pattern.startsWith("*.") && !pattern.includes('/')) pattern = "**/"+pattern;

			const entries = await glob(pattern, path, showHidden);

			let prefix = '';
			let items = 0;
			let modSince = modifiedSince ? +new Date(modifiedSince) : 0;
			if (!isFinite(modSince)) throw 'Invalid date';

			const result = [];

			for await (const [name, handle, relDir] of entries) {
				const displayPath = relDir ? relDir + '/' + name : name;

				if (items >= limit) {
					prefix = `[TRUNCATED to ${limit} entries, use a more specific path or pattern]\n`;
					break;
				}
				if (!json) items++;

				if (handle.kind === 'file') {
					const file = await handle.getFile();
					if (file.lastModified > modSince) {
						const item = [displayPath, "file", json ? file.size : formatSize(file.size)];
						if (showModified || modSince) item.push(json ? file.lastModified : new Date(file.lastModified).toISOString().slice(0, -5)+'Z');
						result.push(item);
					}
				} else if ((showDir != null ? showDir : !modSince)) {
					const ignore = ignored.test(displayPath, true);
					result.push([displayPath, ignore === 'dir' ? "dir (descents skipped)" : "dir"]);
				}
			}

			if (modSince) result.sort((a, b) => b[3] - a[3]);

			if (json) return result;
			return result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]";
		}
	};

	/**
	 * Walk the filesystem matching a glob pattern.
	 * Yields { name, relDir, handle } where handle is the FileSystemHandle.
	 * @param {string} pattern
	 * @param {string} path
	 * @param {boolean} [showHidden=false]
	 * @return {Promise<AsyncGenerator<[name: string, relDir: string, handle: FileSystemDirectoryHandle | FileSystemFileHandle]>>}
	 */
	const glob = async (pattern, path, showHidden) => {
		const result = compileGlobPattern(pattern, path);
		if (!result) return [];

		const segments = result.segments;
		const handle = await resolveDirectory(rootHandle, result.path);

		async function* walk(dirHandle, relDir, segIdx) {
			const seg = segments[segIdx];
			const nextIdx = segIdx + 1;
			const isLast = nextIdx >= segments.length;

			if (seg === '**') {
				if (isLast) {
					yield* yieldDescendants(dirHandle, relDir);
				} else {
					// ** matches zero directories
					yield* walk(dirHandle, relDir, nextIdx);
					// ** matches one-or-more directories
					for await (const [name, entryHandle] of dirHandle.entries()) {
						const childPath = relDir ? relDir + '/' + name : name;
						if (entryHandle.kind === 'directory' && !ignored.test(childPath, true)) {
							yield* walk(entryHandle, childPath, segIdx);
						}
					}
				}
				return;
			}

			for await (const [name, handle] of dirHandle.entries()) {
				if (name[0] === '.' && !showHidden) continue;
				if (!seg.test(name)) continue;

				const entryPath = relDir ? relDir + '/' + name : name;
				const isDir = handle.kind === 'directory';

				if (isLast) {
					if (!ignored.test(entryPath, isDir)) {
						yield [name, handle, relDir];
					}
				} else if (isDir && !ignored.test(entryPath, true)) {
					yield* walk(handle, entryPath, nextIdx);
				}
			}
		}

		async function* yieldDescendants(dirHandle, relDir) {
			for await (const [name, handle] of dirHandle.entries()) {
				const entryPath = relDir ? relDir + '/' + name : name;
				const isDir = handle.kind === 'directory';

				const ignore = ignored.test(entryPath, isDir);
				if (ignore || (name[0] === '.' && !showHidden)) {
					if (ignore === 'dir') yield [name, handle, relDir];
					continue;
				}

				yield [name, handle, relDir];
				if (isDir) {
					yield* yieldDescendants(handle, entryPath);
				}
			}
		}

		return walk(handle, result.prefix, 0);
	};

	/** Resolve a File from a path relative to root handle */
	const resolveFile = async path => {
		const [parent, name] = await resolveParent(rootHandle, path);
		if (!name) throw "Root is not file";
		try {
			const fileHandle = await parent.getFileHandle(name);
			return await fileHandle.getFile();
		} catch (e) {
			if (e.name === "NotFoundError")
				throw 'File '+JSON.stringify(path)+" not exist";
			throw e;
		}
	};

	const fsCommonApi = {
		list: api.list,
		absPath: AS_IS,
		/**
		 * @param {string} path
		 * @returns {Promise<string>}
		 */
		async read(path) {
			const file = await resolveFile(path);
			return readAsString(file);
		},
		/**
		 * @param {string} path
		 * @param {string|Uint8Array} data
		 * @param [_ctx]
		 * @param {1} [_overwrite]
		 * @returns {Promise<void>}
		 */
		async write(path, data, _ctx, _overwrite) {
			await checkPath(path);
			const [ parent, name ] = await resolveParent(rootHandle, path, CREATE);

			let fileHandle;
			try {
				fileHandle = await parent.getFileHandle(name);
			} catch {}

			if (fileHandle) {
				try {
					if (_overwrite && config.fs_trashCan) {
						const file = await fileHandle.getFile();
						needChange:
						if (data instanceof Uint8Array && file.size === data.length) {
							const ab = new Uint8Array(await file.arrayBuffer());
							for (let i = 0; i < data.length; i++) {
								if (ab[i] !== data[i]) break needChange;
							}
							return;
						}

						await copyEntry(fileHandle, await rootHandle.getDirectoryHandle(".trash", CREATE), Date.now()+"_"+name, true);
					} else {
						await parent.removeEntry(name);
					}
				} catch (e) {
					if (e.name === FILE_TOO_BIG) {
						throw "Failed to write file, permission denied.";
					}
					throw e;
				}
			}

			fileHandle = await parent.getFileHandle(name, CREATE);
			const writable = await fileHandle.createWritable();
			await writable.write(data);
			await writable.close();

			if (/\.(gitignore|ignore)$/.test(path)) await loadIgnore();
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

	// ── Binary I/O (bypass line cache) ──

	return {
		...api,
		...teh,

		open: async ({ path, create }) => {
			const [parent, name] = await resolveParent(rootHandle, path);
			if (!name) throw "Root is not file";
			return parent.getFileHandle(name, create ? CREATE : undefined);
		},
		readRaw: ({path}) => resolveFile(path),
		writeRaw: async ({path, content}) => {
			await fsCommonApi.write(path, content, null, 1);
			teh.del(path);
		},
		appendRaw: api.append
	};
};