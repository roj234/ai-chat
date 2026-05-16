import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readBOM} from "../../common/chardet.js";
import iconv from "iconv-lite";
import {getEnvironmentPrompt} from "../utils/checkEnv.js";

const execFilePromise = promisify(execFile);

/**
 * 行内容缓存（WeakRef）
 * @type {Map<string, WeakRef<string[]>>}
 */
const cache = new Map;

/**
 * 路径索引（暂未使用，保留）
 * @type {Map<string, string>}
 */
const fileIndex = new Map;

/**
 * 安全工具：路径校验
 * @param {RouteContext} ctx
 * @param {string} relPath
 * @return {*|string}
 */
export function pathFilter(ctx, relPath) {
	if (fileIndex.has(relPath)) return fileIndex.get(relPath);
	const targetPath = path.resolve(ctx.sandboxRoot, relPath.replace(/^\/+/, ''));
	if (!targetPath.startsWith(ctx.sandboxRoot)) {
		const err = new Error('Forbidden: Path Traversal');
		err.statusCode = 403;
		throw err;
	}
	return targetPath;
}

const HASHLINE_META_HEAD = '[Metadata]\n';
const HASHLINE_META_SEP = '[Raw content]\n';
const HASHLINE_META_SEP_ANCHOR = '[Content with anchors]\n';
const HASHLINE_LINE_SEP = '#';
const HASHLINE_CONTENT_SEP = '\t';
const shaHash = (content, len = 4) => crypto.createHash('sha-1').update(content).digest('hex').slice(0, len);
const hashLine = (line, index) => `${index + 1}${HASHLINE_LINE_SEP}${shaHash(line)}`;

function parseHash(hash, lines) {
	hash = hash.toLowerCase();
	if (hash === HASHLINE_LINE_SEP+'eof') return lines.length;
	const idx = hash.indexOf(HASHLINE_LINE_SEP);
	if (idx < 0 || hash.length !== 5 + idx) {
		throw "invalid anchor format, must be `line#hash`";
	}

	const lineNo = parseInt(hash.slice(0, idx)) - 1;
	const line = lines[lineNo];
	if (line && shaHash(line) === hash.slice(idx + 1)) return lineNo;

	let best = -1, bestDist = 50;
	let i = 0;
	for(;;) {
		i = lines.anchors.indexOf(hash, i);
		if (i < 0) break;

		const dist = Math.abs(i - lineNo);
		if (dist < bestDist) { best = i; bestDist = dist; }

		i += 1;
	}

	return best;
}

/**
 * 尝试用指定编码解码 Blob，失败时抛出异常。
 * 通过检查替换字符 (U+FFFD) 比例来判断二进制/乱码。
 */
function tryDecode(buffer, charset) {
	const text = iconv.decode(buffer, charset);

	let unprintable = 0;
	for (let i = 0; i < Math.min(text.length, 10000); i++) {
		const char = text.charCodeAt(i);
		if (char < 32 && char !== 9 && char !== 10 && char !== 13) {
			unprintable++;
			if (unprintable > 10 && unprintable / (i+1) > 0.05)
				return null;
		}
	}
	return text;
}

async function readAsString(buffer) {
	const blob = new Blob([buffer]);
	const [charset, skip] = await readBOM(blob);

	if (charset) return tryDecode(buffer, charset);

	return tryDecode(buffer, 'UTF-8') || tryDecode(buffer, 'GB18030');
}

/**
 *
 * @param {string} filePath
 * @return {Promise<string[]>}
 */
async function readLines(filePath) {
	const buffer = await fs.readFile(filePath);
	const str = await readAsString(buffer);
	if (str == null) throw new Error("Unsupported charset (or binary file).");

	const { mtime } = await fs.stat(filePath);
	let lines = cache.get(filePath)?.deref();
	if (!lines || lines.mtime < mtime) {
		const content = await fs.readFile(filePath, 'utf-8');
		lines = content.split(/\r?\n/);
		lines.anchors = lines.map(hashLine);
		lines.mtime = Date.now();
		cache.set(filePath, new WeakRef(lines));
	}
	return lines;
}

/**
 * 将 Linux 文件模式（整数，如 0o100644）转换为字符串表示，如 "-rw-r--r--"
 * @param {number} mode - 包含文件类型和权限的完整模式 (st_mode)
 * @returns {string} 长度为 10 的权限字符串
 */
function modeToString(mode) {
	// 文件类型掩码及常量
	const S_IFMT   = 0o170000;
	const S_IFSOCK = 0o140000;
	const S_IFLNK  = 0o120000;
	const S_IFREG  = 0o100000;
	const S_IFBLK  = 0o060000;
	const S_IFDIR  = 0o040000;
	const S_IFCHR  = 0o020000;
	const S_IFIFO  = 0o010000;

	// 确定文件类型字符
	const typeMask = mode & S_IFMT;
	let typeChar;
	switch (typeMask) {
		case S_IFREG:  typeChar = '-'; break;
		case S_IFDIR:  typeChar = 'd'; break;
		case S_IFLNK:  typeChar = 'l'; break;
		case S_IFCHR:  typeChar = 'c'; break;
		case S_IFBLK:  typeChar = 'b'; break;
		case S_IFIFO:  typeChar = 'p'; break;
		case S_IFSOCK: typeChar = 's'; break;
		default:       typeChar = '?'; break;
	}

	// 提取各权限组 (0-7)
	const user  = (mode >> 6) & 7;
	const group = (mode >> 3) & 7;
	const other = mode & 7;

	// 特殊权限位
	const setuid = (mode & 0o4000) !== 0;
	const setgid = (mode & 0o2000) !== 0;
	const sticky = (mode & 0o1000) !== 0;

	/**
	 * 将权限位转为 rwx 字符串，处理特殊位显示
	 * @param {number} perm - 权限位 (0-7)
	 * @param {boolean} hasSpecial - 是否设置了特殊位
	 * @param {string} specialChar - 特殊位字符 ('s' 或 't')
	 * @returns {string} 长度为 3 的权限字符串
	 */
	function permChars(perm, hasSpecial, specialChar) {
		const r = (perm & 4) ? 'r' : '-';
		const w = (perm & 2) ? 'w' : '-';
		let x;
		if (hasSpecial) {
			// 有执行权限 -> 小写，否则 -> 大写
			x = (perm & 1) ? specialChar : specialChar.toUpperCase();
		} else {
			x = (perm & 1) ? 'x' : '-';
		}
		return r + w + x;
	}

	const userStr  = permChars(user, setuid, 's');
	const groupStr = permChars(group, setgid, 's');
	const otherStr = permChars(other, sticky, 't');

	return typeChar + userStr + groupStr + otherStr;
}

// ---------- 路由注册 ----------

/**
 * @param {AiChatBackend.Router} router
 * @param {boolean} allowExec
 */
export function registerFsRoutes(router, allowExec) {
	// 辅助：发送非 JSON 响应（如图片、文本）
	const sendRaw = (res, status, contentType, data) => {
		res.writeHead(status, { 'Content-Type': contentType });
		res.end(data);
	};
	const sendText = (res, text) => sendRaw(res, 200, 'text/plain', text);

	router.get('/env', async (ctx) => {
		return ctx.send(200, { prompt: await getEnvironmentPrompt() })
	})

	// 1. 读取文件或目录内容
	router.post('/read', async (ctx) => {
		const { path: filePath, start, end, max_chars = 32768, format = "raw" } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const stats = await fs.stat(safePath);
		if (stats.size > 10485760) {
			return ctx.send(400, { error: `File too big (${stats.size} bytes)` });
		}

		const lines = await readLines(safePath);
		const first = start != null ? start - 1 : 0;
		const last = end != null ? Math.min(end, lines.length) : lines.length;
		if (first < 0) {
			return ctx.send(400, { error: 'Start line must > 0' });
		}
		if (first > last) {
			return ctx.send(400, { error: 'Resolved end line is before start line' });
		}

		let limit = max_chars;
		let truncated = 0;
		const respLines = [];

		for (let i = first; i < last; i++) {
			const line = lines[i];
			if (limit < line.length) {
				truncated = (last - i) + " lines before line#"+(i+1)+" (length: "+line.length+")";
				break;
			}
			limit -= line.length;

			let text;
			switch (format) {
				case "raw": text = line; break;
				case "anchors": text = lines.anchors[i] + HASHLINE_CONTENT_SEP + `${line}`; break;
				default: text = (i+1)+'\t'+line; break;
			}

			respLines.push(text);
		}

		let content = respLines.join('\n');
		if (truncated) content += `\n[TRUNCATED: ${respLines.length} of ${last - first} lines shown]`;

		sendText(ctx.res, content);
	});

	router.post('/read_image', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const stats = await fs.stat(safePath);
		if (stats.size > 10485760) {
			return ctx.send(400, { error: `File too big (${stats.size} bytes)` });
		}

		const ext = safePath.slice(safePath.lastIndexOf('.') + 1).toLowerCase();
		// 图片直接返回二进制
		if (['png', 'jpg', 'bmp', 'jpeg'].includes(ext)) {
			const data = await fs.readFile(safePath);
			return sendRaw(ctx.res, 200, `image/${ext}`, data);
		}

		ctx.send(400, { error: `File extension is current not allowed` });
	});

	// 2. 替换文件内容（按标签）
	router.post('/patch', async (ctx) => {
		const { path: filePath, patches } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const lines = await readLines(safePath);
		let patchReport = '';
		try {
			/** @type {{ start: number, end: number, patchLines: string[] }[]} */
			const parsedPatches = [];
			for (const { start_anchor, end_anchor, lines: patchLines } of patches) {
				const start = parseHash(start_anchor, lines);
				const end = parseHash(end_anchor, lines);
				if (start < 0) throw 'Error locating anchor '+start_anchor+': The file may has changed significantly. Re-read to get fresh anchors.';
				if (end < 0) throw 'Error locating anchor '+end_anchor+': The file may has changed significantly. Re-read to get fresh anchors.';
				if (start > end) throw 'Resolved end line is before start line: The file may has changed significantly. Re-read to get fresh anchors.';

				parsedPatches.push({ start, end, patchLines });
			}
			parsedPatches.sort((a, b) => a.start - b.start);

			for (let i = 1; i < parsedPatches.length; i++) {
				const cur = parsedPatches[i];
				const prev = parsedPatches[i - 1];
				if (cur.start < prev.end) throw 'Patch '+i+'('+cur.start+', '+cur.end+') overlap with patch '+(i-1)+'('+prev.start+','+prev.end+').';
			}

			const newLines = [];
			const newAnchors = [];

			const push = (array, offset) => {
				newLines.push(...array);
				newAnchors.push(...array.map((line, i) => hashLine(line, offset + i)));
			}

			let lastIndex = 0;

			for (let i = 0; i < parsedPatches.length; i++){
				const {start, end, patchLines} = parsedPatches[i];

				push(lines.slice(lastIndex, start), lastIndex);
				const patchStart = newLines.length;
				push(patchLines, patchStart);

				const oldLen = end - start;
				const newLen = patchLines.length;
				const delta = newLen - oldLen;

				if (patchReport) patchReport += '\n';
				patchReport += "[Patch "+(i+1)+"]\n" + "Range: ["+(start+1)+", "+(end+1)+")\nNew lines: "+newLen+" ("+(delta > 0 ? "+"+delta : delta)+")\n";
				patchReport += HASHLINE_META_SEP_ANCHOR + patchLines.map((line, i) => newAnchors[patchStart + i] + HASHLINE_CONTENT_SEP + line).join("\n");

				lastIndex = end;
			}

			push(lines.slice(lastIndex), lastIndex);

			newLines.anchors = newAnchors;
			newLines.mtime = Date.now();
			cache.set(filePath, new WeakRef(newLines));

			await fs.writeFile(safePath, newLines.join('\n'), 'utf-8');
		} catch (e) {
			return ctx.send(400, { error: e.toString() });
		}

		sendText(ctx.res, patchReport);
	});

	// 替换文件内容（简单查找替换）
	// 这是AiChat用HashLine自己写的，这何尝不是一种自举？
	router.post('/replace', async (ctx) => {
		const { path: filePath, search, replace, all, start_line, end_line } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const content = await readAsString(await fs.readFile(safePath));

		let newContent;
		if (all) {
			newContent = content.replaceAll(search, replace);
		} else {
			// 统计匹配数并记录最后位置
			let count = 0;
			let lastIdx = -1;
			let idx = -1;
			while ((idx = content.indexOf(search, idx + 1)) !== -1) {
				count++;
				lastIdx = idx;
			}

			if (count === 0) {
				return ctx.send(400, { error: `'search' was not found in the file.` });
			}

			if (count > 1) {
				return ctx.send(400, { error: `Found ${count} occurrences of the search string — the search must uniquely identify a single location. Please expand the 'search' to include more surrounding context.` });
			}

			newContent = content.slice(0, lastIdx) + replace + content.slice(lastIdx + search.length);
		}

		await fs.writeFile(safePath, newContent, 'utf-8');

		cache.delete(filePath);

		ctx.send(200, { success: true });
	});

	// 3. 写入文件（创建/覆写）
	router.post('/write', async (ctx) => {
		let { path: filePath, lines, content, return_anchors = false } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		await fs.mkdir(path.dirname(safePath), { recursive: true });
		await fs.writeFile(safePath, content || lines.join('\n'), 'utf-8');

		if (!lines) lines = content.split("\n");
		const anchors = lines.map(hashLine);

		// 更新缓存
		lines.anchors = anchors;
		cache.set(filePath, new WeakRef(lines));

		if (return_anchors) {
			sendText(ctx.res, HASHLINE_META_HEAD+"Lines: "+lines.length+"\n"+HASHLINE_META_SEP_ANCHOR+lines.map((line, i) => anchors[i]+HASHLINE_CONTENT_SEP+line).join("\n"));
		} else {
			// sendText(ctx.res, "File created successfully at "+safePath);
			ctx.send(200, { success: true });
		}
	});

	// 4. 创建目录
	router.post('/mkdirs', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		await fs.mkdir(pathFilter(ctx, filePath), { recursive: true });
		ctx.send(200, { success: true });
	});

	// 5. 复制/移动
	router.post('/copy', async (ctx) => {
		const { src, dest, move } = await ctx.readAsObject();
		const safeSrc = pathFilter(src);
		const safeDest = pathFilter(dest);
		if (move) {
			await fs.rename(safeSrc, safeDest);
		} else {
			await fs.cp(safeSrc, safeDest, { recursive: true });
		}
		ctx.send(200, { success: true });
	});

	// 6. 文件/目录信息
	router.post('/stat', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const stats = await fs.stat(pathFilter(ctx, filePath));
		ctx.send(200, {
			mode: modeToString(stats.mode),
			size: stats.size,
			atime: new Date(stats.atimeMs).toISOString(),
			mtime: new Date(stats.mtimeMs).toISOString(),
			ctime: new Date(stats.ctimeMs).toISOString(),
			nlink: stats.nlink,
			type: stats.isDirectory() ? "dir" : "file"
		});
	});

	// 7. 删除
	router.post('/delete', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		if (safePath === ctx.sandboxRoot) return ctx.send(403, { error: 'Cannot delete root' });

		await fs.rm(safePath, { recursive: true, force: true });
		cache.delete(filePath);
		ctx.send(200, { success: true });
	});

	// 8. 列表
	router.post('/list', async (ctx) => {
		const { path: filePath, glob } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const entries = glob
			? await fs.glob(glob, { cwd: safePath, withFileTypes: true })
			: await fs.readdir(safePath, { withFileTypes: true });

		let text = '';
		let items = 0;
		const MAX_COUNT = 1000;
		for await (const entry of entries) {
			if (items >= MAX_COUNT) {
				text += `[TRUNCATED: Only first ${MAX_COUNT} files shown, retry with glob?`;
				break;
			}

			const name = glob ? path.join(entry.parentPath, entry.name) : entry.name;
			if (entry.isFile()) {
				const fullPath = path.join(entry.parentPath, entry.name);
				const stats = await fs.stat(fullPath);
				text += JSON.stringify(name)+"\tfile\t"+stats.size+"\n";
			} else {
				text += JSON.stringify(name)+"\tdir\n";
			}
			items++;
		}
		const result = text.trim();
		sendText(ctx.res, result ? "\"name\"\ttype\tsize\n"+result : "Empty folder");
	});

	if (allowExec) {
		router.post('/spawn', async (ctx) => {
			const { program, arguments: args, directory, timeout = 10 } = await ctx.readAsObject();
			const safeCwd = pathFilter(ctx, directory);
			const result = await execFilePromise(program, args, {
				cwd: safeCwd,
				timeout: timeout * 1000
			}).catch(({code, stdout, stderr}) => ({
				code, stdout, stderr
			}));
			sendText(ctx.res, `Exit code ${result.code || 0}\n`+result.stdout+result.stderr);
		});
	}
}