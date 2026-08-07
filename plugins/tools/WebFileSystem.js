import {readAsString} from "/common/chardet.js";
import {createTextFileEditHelper} from "/common/fs-common.js";
import {IgnoreMatcher} from "/common/ignore.js";
import {normalizePath} from "unconscious/common/path-utils.js";
import {formatSize} from "unconscious/common/Utils.js";

// ────────────────────────────────── Glob‑to‑Regex (ported from Globs.java) ──────────────────────────

const REGEX_META_CHARS = new Set('.^$+{[]|()');
const GLOB_META_CHARS = new Set('\\*?[{');

const EOL = undefined;
const next = (glob, i) => i < glob.length ? glob[i] : EOL;

/**
 * Converts a glob pattern (Unix style) to a RegExp pattern string.
 * Ported from Globs.toRegexPattern with isDos = false.
 */
function globToRegexPattern(globPattern) {
	let inGroup = false;
	const regex = ['^'];

	let i = 0;
	while (i < globPattern.length) {
		let c = globPattern[i++];
		switch (c) {
			case '\\': {
				if (i === globPattern.length)
					throw new Error(`No character to escape at position ${i - 1}`);
				const nextChar = globPattern[i++];
				if (GLOB_META_CHARS.has(nextChar) || REGEX_META_CHARS.has(nextChar)) regex.push('\\');
				regex.push(nextChar);
				break;
			}
			case '/': {
				regex.push('/');
				break;
			}
			case '[': {
				regex.push('[[^/]&&[');
				if (next(globPattern, i) === '^') {
					regex.push('\\^');
					i++;
				} else {
					if (next(globPattern, i) === '!') {
						regex.push('^');
						i++;
					}
					if (next(globPattern, i) === '-') {
						regex.push('-');
						i++;
					}
				}
				let hasRangeStart = false;
				let last = 0;
				while (i < globPattern.length) {
					c = globPattern[i++];
					if (c === ']') break;
					if (c === '/') throw new Error(`Explicit 'name separator' in class at ${i - 1}`);
					if (c === '\\' || c === '[' || (c === '&' && next(globPattern, i) === '&')) {
						regex.push('\\');
					}
					regex.push(c);
					if (c === '-') {
						if (!hasRangeStart) throw new Error(`Invalid range at ${i - 1}`);
						c = next(globPattern, i);
						if (c === EOL || c === ']') break;
						if (c < last) throw new Error(`Invalid range at ${i - 3}`);
						regex.push(c);
						i++;
						hasRangeStart = false;
					} else {
						hasRangeStart = true;
						last = c;
					}
				}
				if (c !== ']') throw new Error('Missing \']\'');
				regex.push(']]');
				break;
			}
			case '{': {
				if (inGroup) throw new Error(`Cannot nest groups at ${i - 1}`);
				regex.push('(?:(?:');
				inGroup = true;
				break;
			}
			case '}': {
				if (inGroup) {
					regex.push('))');
					inGroup = false;
				} else {
					regex.push('}');
				}
				break;
			}
			case ',': {
				if (inGroup) {
					regex.push(')|(?:');
				} else {
					regex.push(',');
				}
				break;
			}
			case '*': {
				if (next(globPattern, i) === '*') {
					regex.push('.*');
					i++;
				} else {
					regex.push('[^/]*');
				}
				break;
			}
			case '?': {
				regex.push('[^/]');
				break;
			}
			default: {
				if (REGEX_META_CHARS.has(c)) regex.push('\\');
				regex.push(c);
				break;
			}
		}
	}

	if (inGroup) throw new Error(`Missing '}' at ${i - 1}`);

	regex.push('$');
	return regex.join('');
}

// ────────────────────────────────── FileSystem Helpers ──────────────────────────────────

export const CREATE = { create: true };

/**
 * Resolve parent directory handle and entry name from a full path (relative to root).
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
		throw typeof e === 'string' ? e : ("Parent directory "+parts.join('/')+" not found");
	}
	return [ parent, name ];
};

/**
 * Resolve a directory handle from a path.
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
 * @returns {{
 * 		mkdir({path: string}): Promise<string>,
 * 		copy({src: string, dest: string, move?: boolean}): Promise<string>,
 * 		stat({path: string}): Promise<string>,
 * 		delete({path: string}): Promise<string>,
 * 		list({path: string, glob?: string}): Promise<string>,
 * }}
 */
export const createWebFileSystem = rootHandle => {
	/** @type {IgnoreMatcher} */
	let ignored;
	const loadIgnore = async () => {
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
		if (ignored.test(parsedPath.join('/'), isDir)) throw ('Forbidden: operate ignored path');
	};

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

			async function copyEntry(handle, destDir, destName) {
				if (handle.kind === 'file') {
					const file = await handle.getFile();
					const newHandle = await destDir.getFileHandle(destName, CREATE);
					const writable = await newHandle.createWritable();
					await writable.write(file);
					await writable.close();
				} else {
					const newDir = await destDir.getDirectoryHandle(destName, CREATE);
					const promises = [];
					for await (const [childName, childHandle] of handle.entries()) {
						promises.push(copyEntry(childHandle, newDir, childName));
					}
					await Promise.all(promises);
				}
			}

			if (move) {
				if (typeof srcHandle.move === 'function') {
					// destParent already resolved with MKDIRS, no need for manual mkdirs
					await srcHandle.move(destParent, destName);
				} else {
					// fallback: copy + delete
					await copyEntry(srcHandle, destParent, destName);
					await srcParent.removeEntry(srcName, { recursive: true });
				}
			} else {
				await copyEntry(srcHandle, destParent, destName);
			}

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
			await parent.removeEntry(name, { recursive: true });
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

			const file = await fileHandle.getFile();
			const size = file.size;
			let needNewline;

			if (newline) {
				// Check whether existing content ends with \n
				if (size > 0) {
					const offset = size - 1;
					const lastByte = new Uint8Array((await file.slice(offset, offset + 1).arrayBuffer()))[0];
					needNewline = lastByte !== 0x0a;
				}
			}

			const writable = await fileHandle.createWritable({ keepExistingData: true });
			await writable.seek(size);
			await writable.write(needNewline ? '\n' + content : content);
			await writable.close();

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
			showModified = false
		}) {
			if (!ignored) await loadIgnore();

			pattern = pattern || '*';
			// 行为一致，顺便给AI擦屁股
			if (pattern.startsWith("*.") && !pattern.includes('/')) pattern = "**/"+pattern;

			const entries = pattern !== '*'
				? await glob(pattern, path)
				: (await resolveDirectory(rootHandle, path)).entries();

			let prefix = '';
			let items = 0;
			let modSince = modifiedSince ? +new Date(modifiedSince) : 0;
			if (!isFinite(modSince)) throw 'Invalid date';

			const result = [];

			for await (const [name, handle, relDir] of entries) {
				const displayPath = relDir ? relDir + '/' + name : name;
				const isDir = handle.kind === 'directory';

				if (ignored.test(displayPath, isDir)) continue;

				if (items >= limit) {
					prefix = `[TRUNCATED to ${limit} entries, use a more specific path or pattern]\n`;
					break;
				}
				if (!json) items++;

				if (handle.kind === 'file') {
					const file = await handle.getFile();
					if (file.lastModified > modSince) {
						const item = [displayPath, "file", formatSize(file.size)];
						if (showModified || modSince) item.push(new Date(file.lastModified).toISOString().slice(0, -5)+'Z');
						result.push(item);
					}
				} else if ((showDir != null ? showDir : !modSince)) {
					result.push([displayPath, "dir"]);
				}
			}

			if (modSince) result.sort((a, b) => b[3].localeCompare(a[3]));

			if (json) return result;
			return result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]";
		}
	};

	/**
	 * Walk the filesystem matching a glob pattern.
	 * Yields { name, relDir, handle } where handle is the FileSystemHandle.
	 */
	const glob = async (pattern, searchRoot) => {
		let relDir = '';

		const prefix = pattern.match(/^(?:\.\/)?([^.^$+{[\]|()*?\/]+\/)+/);
		if (prefix) {
			relDir = prefix[0].slice(0, -1);
			searchRoot += '/' + relDir;
			pattern = pattern.slice(prefix[0].length);
		}

		const segments = normalizePath(pattern).map((segment) => {
			if (segment === '**') return segment;
			return new RegExp(globToRegexPattern(segment), 'iu');
		});
		// 处理空pattern
		if (!segments.length) return;

		const handle = await resolveDirectory(rootHandle, searchRoot);

		async function* walk(dirHandle, relDir, segIdx) {
			const seg = segments[segIdx];
			const nextIdx = segIdx + 1;
			const isLast = nextIdx >= segments.length;

			if (seg === '**') {
				if (isLast) {
					yield* yieldChildren(dirHandle, relDir);
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

		async function* yieldChildren(dirHandle, relDir) {
			for await (const [name, handle] of dirHandle.entries()) {
				const entryPath = relDir ? relDir + '/' + name : name;
				const isDir = handle.kind === 'directory';

				if (ignored.test(entryPath, isDir)) continue;

				yield [name, handle, relDir];
				if (isDir) {
					yield* yieldChildren(handle, entryPath);
				}
			}
		}

		return walk(handle, relDir, 0);
	};

	/** Resolve a File from a path relative to root handle */
	const resolveFile = async path => {
		const [parent, name] = await resolveParent(rootHandle, path);
		if (!name) throw "Root is not file";
		const fileHandle = await parent.getFileHandle(name);
		return await fileHandle.getFile();
	};

	const fsCommonApi = {
		list: api.list,

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
		 * @returns {Promise<void>}
		 */
		async write(path, data) {
			await checkPath(path);
			const [ parent, name ] = await resolveParent(rootHandle, path, CREATE);
			const fileHandle = await parent.getFileHandle(name, CREATE);
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

		readRaw: ({path}) => resolveFile(path),
		writeRaw: async ({path, content}) => {
			await fsCommonApi.write(path, content);
			teh.del(path);
		},
		appendRaw: api.append
	};
};