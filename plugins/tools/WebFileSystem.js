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
 * Throws an error if the pattern is invalid.
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
 * Creates a RegExp from a Unix glob pattern (full path).
 */
function compileUnixGlob(pattern) {
	return new RegExp(globToRegexPattern(pattern));
}

/**
 * Create a RegExp that matches a single file / directory name segment.
 * Throws if the segment contains '/'.
 */
function segmentToRegex(segment) {
	if (segment.includes('/')) throw new Error(`Segment must not contain '/': "${segment}"`);
	return new RegExp(globToRegexPattern(segment));
}

// ────────────────────────────────── FileSystem Helpers ──────────────────────────────────

const MKDIRS = { create: true };

/**
 * Resolve parent directory handle and entry name from a full path (relative to root).
 */
async function resolveParent(rootHandle, filePath, options) {
	const parts = filePath.split('/').filter(Boolean);
	const name = parts.pop();
	let parent = rootHandle;
	for (const part of parts) {
		parent = await parent.getDirectoryHandle(part, options);
	}
	return [ parent, name ];
}

/**
 * Resolve a directory handle from a path (leading / allowed).
 */
async function resolveDirectory(rootHandle, dirPath) {
	if (dirPath === '' || dirPath === '/') return rootHandle;
	const parts = dirPath.split('/').filter(Boolean);
	if (parts[0] === '.') parts.shift();

	let handle = rootHandle;
	for (const part of parts) {
		handle = await handle.getDirectoryHandle(part);
	}
	return handle;
}

/**
 * @param {FileSystemDirectoryHandle} rootHandle
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
					for await (const [childName, childHandle] of handle.entries()) {
						await copyEntry(childHandle, newDir, childName);
					}
				}
			}

			if (move) {
				if (typeof srcHandle.move === 'function') {
					await api.mkdirs({path: destParent.name});
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

		async list({path, glob: globStr}) {
			const entries = globStr ? await glob(globStr, path) : await readdir(path);

			let text = '';
			let items = 0;
			const MAX_COUNT = 1000;
			for await (const [name, parentPath, isDir] of entries) {
				if (items >= MAX_COUNT) {
					text += `[TRUNCATED: Only first ${MAX_COUNT} files shown, retry with glob?`;
					break;
				}

				const nameOrPath = globStr ? parentPath + '/' + name : name;
				if (!isDir) {
					const fullPath = parentPath + '/' + name;
					const file = await resolveFile(fullPath);
					text += JSON.stringify(nameOrPath)+"\tfile\t"+file.size+"\n";
				} else {
					text += JSON.stringify(nameOrPath)+"\tdir\n";
				}
				items++;
			}
			const result = text.trim();
			return result ? "\"name\"\ttype\tsize\n"+result : "Empty folder";
		}
	}

	/* ── readdir ──────────────────────────── */
	async function readdir(dirPath) {
		const handle = await resolveDirectory(rootHandle, dirPath);
		async function* entries() {
			for await (const [name, entryHandle] of handle.entries()) {
				yield [
					name,
					dirPath,
					entryHandle.kind === 'directory'
				];
			}
		}
		return entries();
	}

	async function glob(pattern, opts) {
		const cwd = opts?.cwd || '/';
		const startHandle = await resolveDirectory(rootHandle, cwd);

		// Split pattern into segments; special handling for **
		const segments = pattern.split('/').filter(Boolean);
		const hasGlobStar = segments.some(s => s === '**');

		// If no **, we can collect all files and test with a single regex (simpler fallback)
		if (!hasGlobStar) {
			const fullRegex = compileUnixGlob(pattern);
			async function* collect(dirHandle, currentPath) {
				for await (const [name, handle] of dirHandle.entries()) {
					const childPath = currentPath + '/' + name;
					if (handle.kind === 'file' && fullRegex.test(childPath)) {
						yield [ name, currentPath ];
					}
					if (handle.kind === 'directory') {
						yield* collect(handle, childPath);
					}
				}
			}
			return collect(startHandle, cwd === '/' ? '' : cwd);
		}

		// Walk with segment‑aware pruning
		async function* walk(dirHandle, currentPath, segIdx) {
			if (segIdx >= segments.length) return;

			const seg = segments[segIdx];
			const isGlobStar = seg === '**';
			const nextIdx = segIdx + 1;
			const rest = nextIdx < segments.length;

			// If current segment is **, we dive into sub‑directories while also trying to match
			// zero directories (skip the **)
			if (isGlobStar) {
				// Match zero directories: continue with next segment from same directory
				yield* walk(dirHandle, currentPath, nextIdx);
				// Match one or more directories: enter every sub‑directory
				for await (const [name, handle] of dirHandle.entries()) {
					if (handle.kind === 'directory') {
						yield* walk(handle, currentPath + '/' + name, segIdx);   // keep ** in front
					}
				}
				return;
			}

			// Normal segment: create regex and filter entries
			const regex = segmentToRegex(seg);
			for await (const [name, handle] of dirHandle.entries()) {
				if (!regex.test(name)) continue;
				const childPath = currentPath + '/' + name;

				if (!rest) {
					// Last segment: must be a file
					if (handle.kind === 'file') {
						yield [ name, currentPath ];
					}
				} else {
					// Intermediate segment: must be a directory to go deeper
					if (handle.kind === 'directory') {
						yield* walk(handle, childPath, nextIdx);
					}
				}
			}
		}

		return walk(startHandle, cwd === '/' ? '' : cwd, 0);
	}

	async function resolveFile(path) {
		const [parent, name] = await resolveParent(rootHandle, path);
		const fileHandle = await parent.getFileHandle(name);
		return await fileHandle.getFile();
	}

	return {
		...api,
		...createHashLine({
			async read(path) {
				const file = await resolveFile(path);
				return readAsString(file);
			},
			async write(path, data) {
				const [ parent, name ] = await resolveParent(rootHandle, path);
				const fileHandle = await parent.getFileHandle(name, { create: true });
				const writable = await fileHandle.createWritable();
				await writable.write(data);
				await writable.close();
			},
			async mtime(path) {
				const file = await resolveFile(path);
				return file.lastModified;
			}
		})
	};
}