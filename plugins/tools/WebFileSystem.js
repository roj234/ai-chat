import {readAsString} from "/common/chardet.js";
import {createHashLine} from "/common/hash-line.js";

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

const MKDIRS = { create: true };

/**
 * @param {string} path
 * @return {string[]}
 */
function parsePath(path) {
	return path.split('/').filter(s => s && s !== '.');
}

/**
 * Resolve parent directory handle and entry name from a full path (relative to root).
 */
async function resolveParent(rootHandle, filePath, options) {
	const parts = parsePath(filePath);
	const name = parts.pop();
	let parent = rootHandle;
	for (const part of parts) {
		parent = await parent.getDirectoryHandle(part, options);
	}
	return [ parent, name ];
}

/**
 * Resolve a directory handle from a path.
 */
async function resolveDirectory(rootHandle, dirPath) {
	const parts = parsePath(dirPath);
	let handle = rootHandle;
	for (const part of parts) {
		handle = await handle.getDirectoryHandle(part);
	}
	return handle;
}

/**
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @returns {{
 * 		read_image({path: string}): Promise<Blob>,
 * 		mkdirs({path: string}): Promise<string>,
 * 		copy({src: string, dest: string, move?: boolean}): Promise<string>,
 * 		stat({path: string}): Promise<string>,
 * 		delete({path: string}): Promise<string>,
 * 		list({path: string, glob?: string}): Promise<string>,
 * }}
 */
export function createWebFileSystem(rootHandle) {
	const api = {
		async read_image({path}) {
			const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
			if (!['png', 'jpg', 'bmp', 'jpeg'].includes(ext))
				throw new Error(`File extension "${ext}" is currently not allowed`);

			const [ parent, name ] = await resolveParent(rootHandle, path);
			const fileHandle = await parent.getFileHandle(name);

			const file = await fileHandle.getFile();
			if (file.size > 10485760) throw new Error(`File too big (${file.size} bytes)`);

			return file;
		},

		async mkdirs({path}) {
			await resolveParent(rootHandle, path+'/_', MKDIRS);
			return 'done';
		},

		async copy({ src, dest, move }) {
			const [ srcParent, srcName ] = await resolveParent(rootHandle, src);
			const [ destParent, destName ] = await resolveParent(rootHandle, dest, MKDIRS);

			let srcHandle;
			try { srcHandle = await srcParent.getFileHandle(srcName); }
			catch { srcHandle = await srcParent.getDirectoryHandle(srcName); }

			async function copyEntry(handle, destDir, destName) {
				if (handle.kind === 'file') {
					const file = await handle.getFile();
					const newHandle = await destDir.getFileHandle(destName, MKDIRS);
					const writable = await newHandle.createWritable();
					await writable.write(file);
					await writable.close();
				} else {
					const newDir = await destDir.getDirectoryHandle(destName, MKDIRS);
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

			return 'done';
		},

		async stat({path}) {
			const [ parent, name ] = await resolveParent(rootHandle, path);

			let handle;
			try {
				handle = await parent.getFileHandle(name);
			} catch {
				try {
					handle = await parent.getDirectoryHandle(name);
				} catch {
					throw new Error(`Path not found: ${path}`);
				}
			}
			const isDir = handle.kind === 'directory';
			const file = isDir ? null : await handle.getFile();
			let str = `type: ${isDir ? 'dir' : 'file'}`;
			if (file) {
				str += `
size: ${file.size}
mtime: ${new Date(file.lastModified).toISOString()}`
			}
			return str;
		},

		async delete({path}) {
			const [ parent, name ] = await resolveParent(rootHandle, path);
			await parent.removeEntry(name, { recursive: true });
			return 'done';
		},

		/** List directory, optionally with a glob filter */
		async list({path, glob: globStr}) {
			const entries = globStr
				? await glob(globStr, path)
				: (await resolveDirectory(rootHandle, path)).entries();

			let text = '';
			let items = 0;
			const MAX_COUNT = 1000;
			for await (const [name, handle, relDir] of entries) {
				if (items >= MAX_COUNT) {
					text += `[TRUNCATED: Only first ${MAX_COUNT} files shown, retry with glob?`;
					break;
				}

				const displayPath = relDir ? relDir + '/' + name : name;

				if (handle.kind === 'directory') {
					text += JSON.stringify(displayPath) + '\tdir\n';
				} else {
					const file = await handle.getFile();
					text += JSON.stringify(displayPath) + '\tfile\t' + file.size + '\n';
				}
				items++;
			}
			const result = text.trim();
			return result ? '"name"\ttype\tsize\n' + result : '[No files]';
		}
	};

	/**
	 * Walk the filesystem matching a glob pattern.
	 * Yields { name, relDir, handle } where handle is the FileSystemHandle.
	 */
	async function glob(pattern, searchRoot) {
		const handle = await resolveDirectory(rootHandle, searchRoot);
		const segments = parsePath(pattern).map(segmentToRegex);

		async function* walk(dirHandle, relDir, segIdx) {
			if (segIdx >= segments.length) return;

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
						if (entryHandle.kind === 'directory') {
							yield* walk(entryHandle, relDir ? relDir + '/' + name : name, segIdx);
						}
					}
				}
				return;
			}

			for await (const [name, handle] of dirHandle.entries()) {
				if (!seg.test(name)) continue;

				if (isLast) {
					yield [name, handle, relDir];
				} else if (handle.kind === 'directory') {
					yield* walk(handle, relDir ? relDir + '/' + name : name, nextIdx);
				}
			}
		}

		async function* yieldChildren(dirHandle, relDir) {
			for await (const [name, handle] of dirHandle.entries()) {
				yield [name, handle, relDir];
				if (handle.kind === 'directory') {
					yield* yieldChildren(handle, relDir ? relDir + '/' + name : name);
				}
			}
		}

		return walk(handle, '', 0);
	}

	/** Resolve a File from a path relative to root handle */
	async function resolveFile(path) {
		const [parent, name] = await resolveParent(rootHandle, path);
		const fileHandle = await parent.getFileHandle(name);
		return await fileHandle.getFile();
	}

	return {
		...api,
		...createHashLine({
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
				const [ parent, name ] = await resolveParent(rootHandle, path, MKDIRS);
				const fileHandle = await parent.getFileHandle(name, MKDIRS);
				const writable = await fileHandle.createWritable();
				await writable.write(data);
				await writable.close();
			},
			/**
			 * @param {string} path
			 * @returns {Promise<number>}
			 */
			async mtime(path) {
				const file = await resolveFile(path);
				return file.lastModified;
			}
		})
	};
}