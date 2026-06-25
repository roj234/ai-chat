import {readAsString} from "/common/chardet.js";
import {createHashLine} from "/common/hash-line.js";
import {IgnoreMatcher} from "/common/ignore.js";
import {config} from "../../src/states.js";

// ────────────────────────────────── Glob‑to‑Regex (ported from Globs.java) ──────────────────────────

const REGEX_META_CHARS = '.^$+{[]|()';
const GLOB_META_CHARS = '\\*?[{';

function isRegexMeta(c) { return REGEX_META_CHARS.indexOf(c) !== -1; }
function isGlobMeta(c)  { return GLOB_META_CHARS.indexOf(c)  !== -1; }

const EOL = undefined;

function next(glob, i) {
	return i < glob.length ? glob.charAt(i) : EOL;
}

/**
 * Converts a glob pattern (Unix style) to a RegExp pattern string.
 * Ported from Globs.toRegexPattern with isDos = false.
 */
function globToRegexPattern(globPattern) {
	let inGroup = false;
	const regex = ['^'];

	let i = 0;
	while (i < globPattern.length) {
		let c = globPattern.charAt(i++);
		switch (c) {
			case '\\': {
				if (i === globPattern.length)
					throw new Error(`No character to escape at position ${i - 1}`);
				const nextChar = globPattern.charAt(i++);
				if (isGlobMeta(nextChar) || isRegexMeta(nextChar)) regex.push('\\');
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
					c = globPattern.charAt(i++);
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
				if (isRegexMeta(c)) regex.push('\\');
				regex.push(c);
				break;
			}
		}
	}

	if (inGroup) throw new Error(`Missing '}' at ${i - 1}`);

	regex.push('$');
	return regex.join('');
}

/**
 * Create a RegExp that matches a single file / directory name segment.
 * Throws if the segment contains '/'.
 */
function segmentToRegex(segment) {
	if (segment.includes('/')) throw new Error(`Segment must not contain '/': "${segment}"`);
	if (segment === '**') return segment;
	return new RegExp(globToRegexPattern(segment));
}

// ────────────────────────────────── FileSystem Helpers ──────────────────────────────────

const CREATE = { create: true };

/**
 * @param {string} path
 * @return {string[]}
 */
export const normalizePath = path => {
	const arr = path.split('/').filter(s => s && s !== '.');
	for (let i = 0; i < arr.length;) {
		if (arr[i] === '..') {
			arr.splice(--i, 2);
		} else {
			i++;
		}
	}
	return arr;
}

/**
 * Resolve parent directory handle and entry name from a full path (relative to root).
 */
const resolveParent = async (rootHandle, filePath, options) => {
	const parts = normalizePath(filePath);
	const name = parts.pop();
	let parent = rootHandle;
	for (const part of parts) {
		parent = await parent.getDirectoryHandle(part, options);
	}
	return [ parent, name ];
};

/**
 * Resolve a directory handle from a path.
 */
const resolveDirectory = async (rootHandle, dirPath) => {
	const parts = normalizePath(dirPath);
	let handle = rootHandle;
	for (const part of parts) {
		handle = await handle.getDirectoryHandle(part);
	}
	return handle;
};

/**
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @returns {{
 * 		readImage({path: string}): Promise<Blob>,
 * 		mkdirs({path: string}): Promise<string>,
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
		async mkdirs({path}) {
			await checkPath(path, true);
			await resolveParent(rootHandle, path+'/_', CREATE);
			return 'success';
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

			return 'success';
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
			return 'success';
		},

		/**
		 * Append content to a file, optionally ensuring a newline precedes the content
		 * if the existing file doesn't end with one.
		 *
		 * @param {FileSystemDirectoryHandle} rootHandle
		 * @param {string} path
		 * @param {string} content
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
			return "success";
		},

		/** List directory, optionally with a glob filter */
		async list({path, glob: globStr = '*', json = false}) {
			if (!ignored) await loadIgnore();

			const entries = globStr !== '*'
				? await glob(globStr, path)
				: (await resolveDirectory(rootHandle, path)).entries();

			let prefix = '';
			let items = 0;

			const MAX_COUNT = 500;
			const result = [];

			for await (const [name, handle, relDir] of entries) {
				const displayPath = relDir ? relDir + '/' + name : name;
				const isDir = handle.kind === 'directory';

				if (ignored.test(displayPath, isDir)) continue;

				if (items >= MAX_COUNT) {
					prefix = `[TRUNCATED: Only first ${MAX_COUNT} files shown, use a more specific glob or path]\n`;
					break;
				}

				if (handle.kind === 'file') {
					const file = await handle.getFile();
					result.push([displayPath, "file", file.size]);
				} else {
					result.push([displayPath, "dir"]);
				}

				items++;
			}

			if (json) return result;
			return result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]";
		}
	};

	/**
	 * Walk the filesystem matching a glob pattern.
	 * Yields { name, relDir, handle } where handle is the FileSystemHandle.
	 */
	const glob = async (pattern, searchRoot) => {
		const segments = normalizePath(pattern).map(segmentToRegex);
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

		return walk(handle, '', 0);
	};

	/** Resolve a File from a path relative to root handle */
	const resolveFile = async path => {
		const [parent, name] = await resolveParent(rootHandle, path);
		if (!name) throw "Root is not file";
		const fileHandle = await parent.getFileHandle(name);
		return await fileHandle.getFile();
	};

	const hashLine = createHashLine({
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
		 * @param {string} data
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
	});
	return {
		...api,
		...hashLine,
		async read(args) {
			const path = args.path;
			const isImage = path.match(/\.(png|jpg|jpeg|bmp|webp)$/i);
			if (isImage && config.modalities.includes("image")) {
				const file = await resolveFile(path);
				if (file.size > 10485760) throw new Error(`File too large (${file.size} bytes)`);
				return file;
			}

			return hashLine.read(args);
		}
	};
};