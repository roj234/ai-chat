import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readBOM} from "../../common/chardet.js";
import iconv from "iconv-lite";
import {getEnvironmentPrompt} from "../utils/checkEnv.js";
import {createHashLine} from "../../common/hash-line.js";

const execFilePromise = promisify(execFile);

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

	const hashLine = createHashLine({
		async read(path, ctx) {
			const safePath = pathFilter(ctx, path);
			const stats = await fs.stat(safePath);
			if (stats.size > 10485760) {
				return ctx.send(400, { error: `File too big (${stats.size} bytes)` });
			}
			return readAsString(await fs.readFile(safePath));
		},
		async write(path, data, ctx) {
			const safePath = pathFilter(ctx, path);
			await fs.writeFile(safePath, data, 'utf-8');
		},
		async mtime(path, ctx) {
			const safePath = pathFilter(ctx, path);
			const stats = await fs.stat(safePath);
			return stats.mtimeMs;
		}
	});

	router.post('/read', async (ctx) => {
		sendText(ctx.res, await hashLine.read(await ctx.readAsObject(), ctx));
	});
	router.post('/patch', async (ctx) => {
		sendText(ctx.res, await hashLine.patch(await ctx.readAsObject(), ctx));
	});
	router.post('/replace', async (ctx) => {
		sendText(ctx.res, await hashLine.replace(await ctx.readAsObject(), ctx));
	});
	router.post('/write', async (ctx) => {
		sendText(ctx.res, await hashLine.write(await ctx.readAsObject(), ctx));
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
			// TODO pipe
			const data = await fs.readFile(safePath);
			return sendRaw(ctx.res, 200, `image/${ext}`, data);
		}

		ctx.send(400, { error: `File extension is current not allowed` });
	});

	// 文件/目录信息
	router.post('/stat', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const stats = await fs.stat(pathFilter(ctx, filePath));
		ctx.send(200, `
type: ${stats.isDirectory() ? "dir" : "file"}
mode: ${modeToString(stats.mode)}
size: ${stats.size}
atime: ${new Date(stats.atimeMs).toISOString()}
mtime: ${new Date(stats.mtimeMs).toISOString()}
ctime: ${new Date(stats.ctimeMs).toISOString()}
nlink: ${stats.nlink}`);
	});
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

			const name = glob ? path.join(entry.parentPath, entry.name).replace(ctx.sandboxRoot, "").replaceAll("\\", '/') : entry.name;
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

	// 基础操作
	router.post('/mkdirs', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		await fs.mkdir(pathFilter(ctx, filePath), { recursive: true });
		ctx.send(200, 'done');
	});
	router.post('/copy', async (ctx) => {
		const { src, dest, move } = await ctx.readAsObject();
		const safeSrc = pathFilter(ctx, src);
		const safeDest = pathFilter(ctx, dest);
		if (move) {
			await fs.mkdir(path.dirname(safeDest), { recursive: true });
			await fs.rename(safeSrc, safeDest);
		} else {
			await fs.cp(safeSrc, safeDest, { recursive: true });
		}
		ctx.send(200, 'done');
	});
	router.post('/delete', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		if (safePath === ctx.sandboxRoot) return ctx.send(403, { error: 'Cannot delete root' });

		await fs.rm(safePath, { recursive: true, force: true });
		hashLine.del(filePath);
		ctx.send(200, 'done');
	});

	if (allowExec) {
		router.get('/env', async (ctx) => {
			return ctx.send(200, { prompt: await getEnvironmentPrompt() })
		})

		router.post('/spawn', async (ctx) => {
			const { program, arguments: args, directory = "", timeout = 10 } = await ctx.readAsObject();
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