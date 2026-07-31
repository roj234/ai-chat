import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readBOM} from "../../common/chardet.js";
import iconv from "iconv-lite";
import {getEnvironmentPrompt} from "../utils/checkEnv.js";
import {createTextFileEditHelper} from "../../common/fs-common.js";
import {IgnoreMatcher} from "../../common/ignore.js";
import {createReadStream, createWriteStream} from 'node:fs';
import {pipeline} from "node:stream/promises";
import {createHash} from 'node:crypto';
import {normalizePath} from 'unconscious/common/path-utils.js';
import {formatSize} from "unconscious/common/Utils.js";

/**
 * 路径校验
 * @param {RouteContext} ctx
 * @param {string} relPath
 * @return {string}
 */
export const pathFilter = (ctx, relPath) => {
	const root = ctx.fsRoot;
	const targetPath = path.resolve(root, relPath);
	// allow path like /tmp/... or C:/tmp/
	if (!targetPath.startsWith(root) && !/^(?:[a-zA-Z]:)?[\\/]tmp(?:\/|$)/.test(targetPath)) {
		const err = new Error('Forbidden: Path Traversal');
		err.statusCode = 403;
		throw err;
	}
	return targetPath;
};

async function pathFilterWithIgnore(ctx, relPath, isDir) {
	const targetPath = pathFilter(ctx, relPath);

	const root = ctx.fsRoot;
	const processedRelPath = targetPath.slice(root.length+1).replaceAll(path.sep, '/');
	const ignore = await getIgnoreMatcher(root, targetPath);
	if (ignore.test(processedRelPath, isDir)) {
		const err = new Error('Forbidden: operate ignored path');
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
	for (let i = 0; i < Math.min(text.length, 10240); i++) {
		const char = text.charCodeAt(i);
		if (char === 65533 || (char < 32 && char !== 9 && char !== 10 && char !== 13)) {
			unprintable++;
			if (unprintable > 10 && unprintable / (i+1) > 0.05)
				return null;
		}
	}
	return {text,unprintable};
}

function guessCharset(buffer, candidates = ["UTF-8", "GBK"]) {
	let bestResult;
	for (const charset of candidates) {
		const result = tryDecode(buffer, charset);
		if (result) {
			let err = result.unprintable;
			if (!err) return result.text;
			if (!bestResult || err < bestResult.unprintable) bestResult = result;
		}
	}

	if (!bestResult) throw '[Failed to decode binary file]';
	return bestResult.text;
}

async function readAsString(buffer) {
	const blob = new Blob([buffer]);
	const [charset, skip] = await readBOM(blob);

	if (charset) return tryDecode(buffer, charset)?.text;
	return guessCharset(buffer);
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

function killProcess(child) {
	child.kill('SIGTERM');
	setTimeout(() => {
		if (process.platform === 'win32') {
			try {
				spawn('taskkill', ['/T', '/PID', child.pid, '/F'], { stdio: 'ignore' });
			} catch {}
		} else {
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {}
		}
		try { child.kill('SIGKILL'); } catch {}
	}, 3000);
}

const matcherCache = new Map;
/**
 *
 * @param {string} root
 * @param {string} targetDir
 * @returns {Promise<IgnoreMatcher>}
 */
const getIgnoreMatcher = async (root, targetDir) => {
	let matcher = matcherCache.get(root);
	if (!matcher) {
		if (matcherCache.size > 1000)
			matcherCache.delete(matcherCache.keys().next().value);

		matcher = new IgnoreMatcher();

		/*let current = targetDir;
		do {
			current = path.dirname(current);
		} while (current.startsWith(root + path.sep) || current === root);*/

		for (const name of ['.ignore', '.gitignore']) {
			try {
				matcher.parse(await fs.readFile(path.join(root, name), 'utf-8'));
				break;
			} catch {}
		}
		matcher.compile();
		matcherCache.set(root, matcher);
	}

	return matcher;
};

/**
 * @param {AiChatBackend.Router} router
 * @param {boolean} allowExec
 */
export async function registerFsRoutes(router, allowExec) {
	// 辅助：发送非 JSON 响应（如图片、文本）
	const sendRaw = (res, status, contentType, data) => {
		res.writeHead(status, { 'Content-Type': contentType });
		res.end(data);
	};
	const sendText = (res, text) => sendRaw(res, 200, 'text/plain', text);

	const hashLine = createTextFileEditHelper({
		async read(path, ctx) {
			const safePath = pathFilter(ctx, path);
			const stats = await fs.stat(safePath);
			if (stats.size > 10485760) {
				return ctx.send(400, { error: `File too large (${stats.size} bytes)` });
			}
			return readAsString(await fs.readFile(safePath));
		},
		async write(path1, data, ctx) {
			const safePath = await pathFilterWithIgnore(ctx, path1);
			await fs.mkdir(path.dirname(safePath), { recursive: true });
			await fs.writeFile(safePath, data, 'utf-8');
			if (/\.(gitignore|ignore)$/.test(path)) matcherCache.delete(ctx.fsRoot);
		},
		async mtime(path, ctx) {
			const safePath = pathFilter(ctx, path);
			const stats = await fs.stat(safePath);
			return stats.mtimeMs;
		}
	});

	router.post('/ping', async (ctx) => {
		const args = await ctx.readAsObject(1024);
		const hash = createHash("sha256");
		hash.update(args.nonce + 'AiChat');
		ctx.send(200, { pong: hash.digest('hex') });
	});

	router.post('/read', async (ctx) => {
		sendText(ctx.res, await hashLine.read(await ctx.readAsObject(), ctx));
	});
	router.post('/patch', async (ctx) => {
		sendText(ctx.res, await hashLine.patch(await ctx.readAsObject(), ctx));
	});
	router.post('/edit', async (ctx) => {
		sendText(ctx.res, await hashLine.edit(await ctx.readAsObject(), ctx));
	});
	router.post('/write', async (ctx) => {
		sendText(ctx.res, await hashLine.write(await ctx.readAsObject(), ctx));
	});
	router.post('/append', async (ctx) => {
		const { path, content, newline = true } = await ctx.readAsObject();
		const safePath = await pathFilterWithIgnore(ctx, path);

		let needNewline;
		if (newline) {
			try {
				const size = (await fs.stat(safePath)).size;
				if (size) {
					const fd = await fs.open(safePath, 'r');
					const buf = Buffer.allocUnsafe(1);
					await fd.read(buf, 0, 1, size - 1);
					await fd.close();
					needNewline = buf[0] !== 0x0a;
				}
			} catch {}
		}

		await fs.appendFile(safePath, needNewline ? '\n'+content : content, 'utf8');
		if (/\.(gitignore|ignore)$/.test(path)) matcherCache.delete(ctx.fsRoot);
		sendText(ctx.res, "success");
	});

	// ── Binary read/write/append (bypass text line cache) ──

	router.post('/readRaw', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const stats = await fs.stat(safePath);
		if (stats.size > 10485760) {
			return ctx.send(400, { error: `File too large (${stats.size} bytes)` });
		}

		ctx.res.writeHead(200, {
			'Content-Type': 'application/octet-stream',
			'Content-Length': stats.size,
		});
		return pipeline(createReadStream(safePath), ctx.res);
	});

	/**
	 * @param {AiChatBackend.RouteContext} ctx
	 */
	const handler = async (ctx) => {
		const filePath = ctx.searchParams.get('path');
		if (!filePath) return ctx.send(400, { error: 'missing path' });
		const safePath = await pathFilterWithIgnore(ctx, filePath);
		await fs.mkdir(path.dirname(safePath), { recursive: true });

		const buffer = await ctx.readAsBuffer();
		await fs[ctx.url.pathname.endsWith("/appendRaw") ? 'appendFile' : 'writeFile'](safePath, buffer);
		if (/\.(gitignore|ignore)$/.test(filePath)) matcherCache.delete(ctx.fsRoot);
		hashLine.del(filePath);        // invalidate text line cache
		sendText(ctx.res, "success");
	};

	router.post('/writeRaw', handler);
	router.post('/appendRaw', handler);

	// 文件/目录信息
	router.post('/stat', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const stats = await fs.stat(pathFilter(ctx, filePath));
		ctx.send(200, `type: ${stats.isDirectory() ? "dir" : "file"}
mode: ${modeToString(stats.mode)}
size: ${stats.size}
atime: ${new Date(stats.atimeMs).toISOString()}
mtime: ${new Date(stats.mtimeMs).toISOString()}
ctime: ${new Date(stats.ctimeMs).toISOString()}
nlink: ${stats.nlink}`);
	});
	router.post('/list', async (ctx) => {
		const {
			path: filePath = '.',
			pattern = '*',
			json = false,
			limit = 500,
			modifiedSince = 0,
			showDir = null,
			showModified = false
		} = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const ignored = await getIgnoreMatcher(ctx.fsRoot, safePath);

		const entries = pattern !== '*'
			? await fs.glob(pattern, { cwd: safePath, withFileTypes: true })
			: await fs.readdir(safePath, { withFileTypes: true });

		let prefix = '';
		let items = 0;
		let dirPrefix = new Set;
		let modSince = modifiedSince ? +new Date(modifiedSince) : 0;
		if (!isFinite(modSince)) throw 'Invalid date';

		const result = [];
		for await (const entry of entries) {
			const parentPath = entry.parentPath.slice(safePath.length+1).replaceAll(path.sep, '/');
			const entryName = pattern !== '*' && parentPath ? parentPath+'/'+entry.name : entry.name;
			const isDir = entry.isDirectory();
			if (ignored.test(entryName, isDir) || dirPrefix.has(parentPath)) {
				if (isDir) dirPrefix.add(entryName);
				continue;
			}

			if (items >= limit) {
				prefix = `[TRUNCATED to ${limit} entries, use a more specific path or pattern]\n`;
				break;
			}
			if (!json) items++;

			if (!isDir) {
				const fullPath = path.join(entry.parentPath, entry.name);
				const stats = await fs.stat(fullPath);

				if (stats.mtimeMs > modSince) {
					const item = [entryName, "file", formatSize(stats.size)];
					if (showModified || modSince) item.push(stats.mtime.toISOString().slice(0, -5));
					result.push(item);
				}
			} else if (entryName && (showDir != null ? showDir : !modSince)) {
				// 跳过 '.' 当前目录
				result.push([entryName, "dir"]);
			}
		}

		if (modSince) result.sort((a, b) => b[3].localeCompare(a[3]));

		if (json) {
			ctx.send(200, result);
			return;
		}

		sendText(ctx.res, result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]");
	});

	// 基础操作
	router.post('/mkdir', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		await fs.mkdir(await pathFilterWithIgnore(ctx, filePath, true), { recursive: true });
		ctx.send(200, 'Success');
	});
	router.post('/copy', async (ctx) => {
		const { src, dest, move } = await ctx.readAsObject();
		const safeSrc = await (move ? pathFilterWithIgnore(ctx, src, true) : pathFilter(ctx, src));
		const safeDest = await pathFilterWithIgnore(ctx, dest, true);
		if (move) {
			await fs.mkdir(path.dirname(safeDest), { recursive: true });
			await fs.rename(safeSrc, safeDest);
		} else {
			await fs.cp(safeSrc, safeDest, { recursive: true });
		}
		ctx.send(200, 'Success');
	});
	router.post('/delete', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const safePath = await pathFilterWithIgnore(ctx, filePath, true);
		if (safePath === ctx.fsRoot) return ctx.send(403, { error: 'Cannot delete root' });

		await fs.rm(safePath, { recursive: true, force: true });
		hashLine.del(filePath);
		ctx.send(200, 'Success');
	});

	const OUTPUT_LIMIT = 20000;
	const HALF = Math.floor(OUTPUT_LIMIT / 2);

	// Valid string terminator sequences are BEL, ESC\, and 0x9c
	const ST = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
	// OSC sequences only: ESC ] ... ST (non-greedy until the first ST)
	const osc = "(?:\\u001B\\][\\s\\S]*?"+ST+")";
	// CSI and related: ESC/C1, optional intermediates, optional params (supports ; and :) then final byte
	const csi = "[\\u001B\\u009B][\\[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";

	const ANSI_SEQ = new RegExp(osc+"|"+csi, 'g');

	// 后台进程管理：输出全部落盘为日志文件，LLM 可自行 read_file 查看
	/** @type {Map<string, {child: import('node:child_process').ChildProcess, logFile: string, cwd: string, timer?: number}>} */
	const processes = new Map();

	/**
	 * 统一执行命令并限制输出大小，按到达顺序交错拼接 stdout/stderr
	 * @param {string} command     - 要执行的程序或 shell 命令
	 * @param {string[]} args      - 程序参数（shell 模式时传空数组）
	 * @param {object}   options   - { cwd, timeout(ms), shell(boolean|string), safeCwd(用于落盘) }
	 * @returns {Promise<{code: number, text: string}>}
	 */
	async function executeCommand(command, args, { cwd, timeout, shell = false, dir, noTruncate, async: _async }) {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
			shell,
			//detached: detach,
		});

		let head = Buffer.alloc(0), tail = Buffer.alloc(0);
		let totalBytes = 0;

		let filename = `/command-log-${Date.now()}-${child.pid}.log`;
		let file = null;

		/** @param {Buffer} chunk */
		const onData = (chunk) => {
			totalBytes += chunk.length;

			if (file) {
				file.write(chunk);
				tail = Buffer.concat([tail, chunk]).subarray(-HALF);
			} else {
				tail = Buffer.concat([tail, chunk]);
				if (!noTruncate && tail.length > OUTPUT_LIMIT) {
					file = createWriteStream(path.join(cwd, filename), { flags: 'w' });
					file.write(tail);

					head = tail.subarray(0, HALF);
					tail = tail.subarray(-HALF);
				}
			}
		};

		child.stdout.on('data', onData);
		child.stderr.on('data', onData);

		const decode = (buf) => {
			try {
				return guessCharset(buf);
			} catch {
				return buf.toString();
			}
		};
		const getLog = () => {
			if (!file) return decode(tail);

			return `[WARNING: Large output omitted (${formatSize(totalBytes)}), log saved to: ${JSON.stringify(dir + filename)}]\n`
				+ decode(head)
				+ `\n[WARNING: Omitted ${totalBytes - OUTPUT_LIMIT} bytes]\n`
				+ decode(tail);
		};

		const result = await new Promise((resolve) => {
			let timer = setTimeout(() => {
				child.stdout.removeAllListeners('data');
				child.stderr.removeAllListeners('data');

				resolve({
					code: (_async?'':'TIMEOUT, ')+'Running in background (pid='+child.pid+', logPath='+JSON.stringify(dir + filename)+')',
					text: getLog(),
				});

				// Ensure log file exists for remaining output
				if (!file) {
					file = createWriteStream(path.join(cwd, filename), { flags: 'w' });
					file.write(tail);
					head = tail = null;
				} else {
					file.write(tail);
					head = tail = null;
				}

				child.stdout.pipe(file, { end: false });
				child.stderr.pipe(file, { end: false });
			}, Math.min(_async ? 100 : timeout, 275000));

			processes.set(child.pid, { child, logFile: dir+filename, cwd, timer });

			console.log("[进程] 已启动", cwd, command, args);

			child.on('error', (err) => {
				clearTimeout(timer);
				resolve({ code: -1, text: err.message });
			});

			child.on('exit', (code, signal) => {
				if (file) file.end();
				if (head == null) return;

				clearTimeout(timer);
				resolve({
					code: signal ? "KILLED" : code,
					text: getLog()
				});
			});
		});

		return { code: result.code ?? 0, text: result.text.replaceAll(ANSI_SEQ, "") };
	}

	/**
	 * 终止后台程序
	 */
	router.post('/kill', async (ctx) => {
		const { pid } = await ctx.readAsObject();
		const info = processes.get(pid);

		if (!info) return sendText(ctx.res, `Error: process died or not started by agent.`);

		const { child, logFile, timer } = info;

		if (child.killed || child.exitCode !== null) {
			processes.delete(pid);
			return sendText(ctx.res,
				`status: exited earlier
exitCode: ${child.exitCode}
logPath: ${logFile}`
			);
		}

		console.log("[进程] 中止 "+pid);
		clearTimeout(timer);
		processes.delete(pid);
		killProcess(child);

		sendText(ctx.res,
			`status: killed
logPath: ${logFile}`
		);
	});

	let bashPath = 'bash';
	let rgPath = path.join(import.meta.dirname, 'bin', 'rg.exe');
	try {
		await fs.access(rgPath);
	} catch {
		rgPath = 'rg';
	}

	router.post('/grep', async (ctx) => {
		const { maxCount, glob, pattern, path, maxColumns } = await ctx.readAsObject();
		const { code, text } = await executeCommand(rgPath, [
			"--line-number",
			"--no-messages",
			"--heading",
			"--max-columns", maxColumns,
			"--color", "never",
			"--max-count", maxCount,
			"--type-add",
			"foo:"+glob,
			"-tfoo",
			"--path-separator", "/",
			"--",
			pattern,
			normalizePath(path).join('/') || '.',
		], {
			cwd: ctx.fsRoot,
			noTruncate: true,
			dir: '.',
			timeout: 60000,
			charset: 'utf8'
		});

		if (code === -1 && text.includes("ENOENT")) {
			// TODO backend grep
		}

		sendText(ctx.res, `${typeof code === 'number'?'Exit code '+code:code}\n${text}`);
	});

	if (allowExec) {
		console.log("正在检测环境，这可能需要几秒钟（特别是容器内）...");
		const envPrompt = await getEnvironmentPrompt();

		let defaultShell = 'bash';
		if (envPrompt.startsWith("os: Windows")) {
			defaultShell = envPrompt.includes("bash: No") ? 'powershell' : "bashemu";
		}

		console.log(envPrompt);
		console.log("\n默认 shell: "+defaultShell);

		router.get('/env', async (ctx) => {
			return ctx.send(200, { prompt: envPrompt, location: ctx.fsRoot })
		});

		router.post('/spawn', async (ctx) => {
			const {
				program, arguments: args, cwd = '',
				timeout = 10, async = false,
				noTruncate = false, charset = 'utf8'
			} = await ctx.readAsObject();
			const { code, text } = await executeCommand(program, args, {
				cwd: await pathFilterWithIgnore(ctx, cwd, true),
				noTruncate,
				dir: '.',
				timeout: timeout * 1000,
				async,
				charset
			});
			sendText(ctx.res, `${typeof code === 'number'?'Exit code '+code:code}\n${text}`);
		});

		router.post('/shell', async (ctx) => {
			let {
				command, cwd = '', shell = defaultShell,
				timeout = 10, async = false,
				charset = 'utf8',
			} = await ctx.readAsObject();
			let args = [];

			if (shell === 'bashemu') {
				shell = false;
				args = ['-c', command];
				command = bashPath;
			}

			const { code, text } = await executeCommand(command, args, {
				cwd: await pathFilterWithIgnore(ctx, cwd, true),
				dir: '.',
				timeout: timeout * 1000,
				async,
				shell,
				charset
			});
			sendText(ctx.res, `${typeof code === 'number'?'Exit code '+code:code}\n${text}`);
		});
	}
}