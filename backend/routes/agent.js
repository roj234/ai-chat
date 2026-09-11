import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readBOM} from "../../common/chardet.js";
import iconv from "iconv-lite";
import {getEnvironmentPrompt} from "../utils/checkEnv.js";
import {createTextFileEditHelper, GREP_MAX_COLUMNS} from "../../common/fs-common.js";
import {ACL} from "../../common/ACL.js";
import {createReadStream, createWriteStream} from 'node:fs';
import {pipeline} from "node:stream/promises";
import {formatSize} from "unconscious/common/Utils.js";
import {LRUCache} from "../../common/LRUCache.js";
import {compileGlobPattern, emptyAsyncGenerator, generateGlobCode} from "../../common/fs-glob.js";
import {Writable} from 'node:stream';
// noinspection ES6UnusedImports
import {mpscScheduler} from "../../common/pure-utils.js";

const devNull = () => new Writable({
	write(chunk, encoding, callback) {
		callback();
	},
});

const TEXT_FILE_MAX = 10485760;
const BINARY_FILE_MAX = 52428800;

/**
 * 路径校验
 * @param {string} relPath
 * @param {RouteContext} ctx
 * @return {string}
 */
export const pathFilter = (relPath, ctx) => {
	const root = ctx.fsRoot;
	const targetPath = path.resolve(root, relPath);
	// allow path like /tmp/... or C:/tmp/
	if (!globalThis.AIChatArgs.noSandbox && !(targetPath+"\\").startsWith(root) && !/^(?:[a-zA-Z]:)?[\\/]tmp(?:\/|$)/.test(targetPath)) {
		const err = new Error('Path Traversal');
		err.statusCode = 403;
		throw err;
	}
	return targetPath;
};

async function pathFilterWithIgnore(ctx, relPath, isDir) {
	const targetPath = pathFilter(relPath, ctx);

	const root = ctx.fsRoot;
	const processedRelPath = targetPath.slice(root.length+1).replaceAll(path.sep, '/');
	const acl = await getACL(root, targetPath);
	if (acl.denyList(processedRelPath, isDir)) {
		const err = new Error(`This path is readonly`);
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

const IS_WIN = process.platform === 'win32';

/**
 * 结束进程树。
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [gracePeriod] SIGTERM 升级到 SIGKILL 的宽限期(ms)，0 表示立即升级
 * @returns {Promise<void>} Windows 下在 taskkill 返回后 resolve
 */
function killProcess(child, gracePeriod = 3000) {
	const pid = child.pid;
	// 用 exitCode/signalCode 判断，child.killed 只代表"发过信号"
	if (pid == null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

	if (IS_WIN) {
		return new Promise((resolve) => {
			let settled = false;
			const done = (ok) => {
				if (settled) return;
				settled = true;
				if (!ok) try { child.kill('SIGKILL'); } catch {}
				resolve();
			};
			const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
			killer.on('error', () => done(false));
			killer.on('exit', (code) => done(code === 0));
		});
	}

	const sig = gracePeriod > 0 ? 'SIGTERM' : 'SIGKILL';
	try {
		process.kill(-pid, sig);
	} catch {
		try { child.kill(sig); } catch {}
	}
	if (gracePeriod <= 0) return Promise.resolve();

	const timer = setTimeout(() => {
		try { process.kill(-pid, 'SIGKILL'); } catch {
			try { child.kill('SIGKILL'); } catch {}
		}
	}, gracePeriod);
	timer.unref?.();

	return Promise.resolve();
}

const matcherCache = new LRUCache(255);
/**
 *
 * @param {string} root
 * @param {string} targetDir
 * @returns {Promise<ACL>}
 */
const getACL = async (root, targetDir) => {
	let matcher = matcherCache.get(root);
	if (!matcher) {
		matcher = new ACL();

		/*let current = targetDir;
		do {
			current = path.dirname(current);
		} while (current.startsWith(root + path.sep) || current === root);*/

		for (const name of ['.ignore', '.gitignore']) {
			try {
				matcher.parseIgnore(await fs.readFile(path.join(root, name), 'utf-8'));
				break;
			} catch {}
		}
		matcher.compile();
		matcherCache.set(root, matcher);
	}

	return matcher;
};

async function glob(pattern, path_, showHidden, acl, exclude) {
	const result = compileGlobPattern(pattern, path_, exclude);
	const handle = result.path;

	try {
		await fs.access(handle);
	} catch {
		return emptyAsyncGenerator();
	}

	return eval(generateGlobCode(true));
}

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

	const listFileHandler = async ({
		path: filePath = '.',
		pattern,
		json = false,
		limit = 500,
		modifiedSince = 0,
		showDir = null,
		showModified = false,
		exclude = [],
		showHidden,
	}, ctx) => {
		pattern = pattern || '*';
		// 行为一致，顺便给AI擦屁股
		if (pattern.startsWith("*.") && !pattern.includes('/')) pattern = "**/"+pattern;

		const safePath = pathFilter(filePath, ctx);
		const acl = await getACL(ctx.fsRoot, safePath);

		if (!(await fs.stat(safePath)).isDirectory()) throw new Error("Path is a file, cannot use glob");

		let prefix = '';
		let modSince = modifiedSince ? +new Date(modifiedSince) : 0;
		if (!isFinite(modSince)) throw 'Invalid date';

		if (null == showHidden) showHidden = /(?:^|\/)\.[^./]/.test(pattern);

		const result = [];
		for await (const entry of await glob(pattern, safePath, showHidden, acl, exclude)) {
			const parentPath = entry.parentPath.slice(safePath.length+1).replaceAll(path.sep, '/');
			const displayPath = pattern !== '*' && parentPath ? parentPath+'/'+entry.name : entry.name;
			const isDir = entry.isDirectory();

			if (!json && result.length >= limit) {
				prefix = `[TRUNCATED to ${limit} entries, use a more specific path or pattern]\n`;
				break;
			}

			const fullPath = path.join(entry.parentPath, entry.name);
			const stats = await fs.stat(fullPath);

			if (!isDir) {
				if (stats.mtimeMs >= modSince) {
					const item = [displayPath, "file", json ? stats.size : formatSize(stats.size)];
					if (showModified || modSince) item.push(json ? stats.mtimeMs : stats.mtime.toISOString().slice(0, -5));
					result.push(item);
				}
			} else if (displayPath && (showDir != null ? showDir : !modSince)) {
				const ignore = acl.denyList(displayPath, true);
				const arr = [displayPath, ignore === 'skip' ? "dir (descents skipped)" : "dir"];
				if (showModified) arr.push(0, json ? stats.mtimeMs : stats.mtime.toISOString().slice(0, -5));
				result.push(arr);
			}
		}

		if (modSince) result.sort((a, b) => b[3] - a[3]);

		if (json) return result;
		return result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]";
	}

	const teh = createTextFileEditHelper({
		list: listFileHandler,
		absPath: pathFilter,
		async read(path, ctx) {
			const stats = await fs.stat(path);
			if (stats.size > TEXT_FILE_MAX) {
				const msg = `File too large (${stats.size} > ${TEXT_FILE_MAX})`;
				if (!ctx) throw msg; // for grep
				return ctx.send(400, { error: msg });
			}
			return readAsString(await fs.readFile(path));
		},
		async write(path1, data, ctx) {
			const safePath = await pathFilterWithIgnore(ctx, path1);
			await fs.mkdir(path.dirname(safePath), { recursive: true });
			await fs.writeFile(safePath, data, 'utf-8');
			if (/\.(gitignore|ignore)$/.test(safePath)) matcherCache.delete(ctx.fsRoot);
		},
		async mtime(path) {
			return (await fs.stat(path)).mtimeMs;
		}
	});

	router.post('/read', async (ctx) => {
		sendText(ctx.res, await teh.read(await ctx.readAsObject(), ctx));
	});
	router.post('/patch', async (ctx) => {
		sendText(ctx.res, await teh.patch(await ctx.readAsObject(), ctx));
	});
	router.post('/edit', async (ctx) => {
		sendText(ctx.res, await teh.edit(await ctx.readAsObject(), ctx));
	});
	router.post('/write', async (ctx) => {
		sendText(ctx.res, await teh.write(await ctx.readAsObject(TEXT_FILE_MAX), ctx));
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
		const safePath = pathFilter(filePath, ctx);
		const stats = await fs.stat(safePath);
		if (stats.size > BINARY_FILE_MAX) {
			return ctx.send(400, { error: `File too large (${stats.size} > ${BINARY_FILE_MAX})` });
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
	const binaryWriteHandler = async (ctx) => {
		const filePath = ctx.searchParams.get('path');
		if (!filePath) return ctx.send(400, { error: 'missing path' });
		const safePath = await pathFilterWithIgnore(ctx, filePath);
		await fs.mkdir(path.dirname(safePath), { recursive: true });

		const buffer = await ctx.readAsBuffer(BINARY_FILE_MAX);
		await fs[ctx.url.pathname.endsWith("/appendRaw") ? 'appendFile' : 'writeFile'](safePath, buffer);
		if (/\.(gitignore|ignore)$/.test(filePath)) matcherCache.delete(ctx.fsRoot);
		teh.del(safePath);
		sendText(ctx.res, "success");
	};

	router.post('/writeRaw', binaryWriteHandler);
	router.post('/appendRaw', binaryWriteHandler);

	// 文件/目录信息
	router.post('/stat', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const stats = await fs.stat(pathFilter(filePath, ctx));
		ctx.send(200, `type: ${stats.isDirectory() ? "dir" : "file"}
mode: ${modeToString(stats.mode)}
size: ${stats.size}
atime: ${new Date(stats.atimeMs).toISOString()}
mtime: ${new Date(stats.mtimeMs).toISOString()}
ctime: ${new Date(stats.ctimeMs).toISOString()}
nlink: ${stats.nlink}`);
	});
	router.post('/list', async (ctx) => {
		const obj = await listFileHandler(await ctx.readAsObject(), ctx);
		if (typeof obj === 'string') sendText(ctx.res, obj);
		else ctx.send(200, obj);
	});

	// 基础操作
	router.post('/mkdir', async (ctx) => {
		const { path: filePath, recursive = true } = await ctx.readAsObject();
		await fs.mkdir(await pathFilterWithIgnore(ctx, filePath, true), { recursive });
		ctx.send(200, 'Success');
	});
	router.post('/copy', async (ctx) => {
		const { src, dest, move } = await ctx.readAsObject();
		const safeSrc = await (move ? pathFilterWithIgnore(ctx, src, true) : pathFilter(src, ctx));
		const safeDest = await pathFilterWithIgnore(ctx, dest, true);
		if (move) {
			await fs.mkdir(path.dirname(safeDest), { recursive: true });
			await fs.rename(safeSrc, safeDest);
		} else {
			await fs.cp(safeSrc, safeDest, { recursive: true, preserveTimestamps: true });
		}
		ctx.send(200, 'Success');
	});
	router.post('/delete', async (ctx) => {
		const { path: filePath, recursive = true, force = false } = await ctx.readAsObject();
		const safePath = await pathFilterWithIgnore(ctx, filePath, true);
		if (safePath === ctx.fsRoot) return ctx.send(403, { error: 'Cannot delete root' });

		await fs.rm(safePath, { recursive, force });
		teh.del(safePath);
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
	/** @type {Map<number, {child: import('node:child_process').ChildProcess, logFile: string, cwd: string, timer: ReturnType<typeof setTimeout>, message?: string, killing?: boolean}>} */
	const processes = new Map();

	globalThis.AiChatAPI.addShutdownHook?.(() => Promise.all([...processes.values()].map(info => killProcess(info.child, 0))));

	// 事件总线
	let events = [];
	let waiters = new Set;
	let eventId = 0;

	const EVENT_QUEUE_CAP = 1000;
	const EVENT_TTL = 3600_000;
	const RUN_ID = Math.random().toString(36).slice(3);

	/**
	 * 发布事件。无论有没有等待者都入队，客户端断线/F5 期间的事件由积压队列补发。
	 */
	const postEvent = (type, data) => {
		const now = Date.now();
		events.push({id: eventId++, type, time: now, ...data});

		while (events.length > EVENT_QUEUE_CAP || (events.length && now - events[0].time > EVENT_TTL))
			events.shift();

		if (waiters.size) {
			waiters.forEach(waiter => waiter());
			waiters.clear();
		}
	};

	router.post('/event', async (ctx) => {
		const {runId, since = 0} = await ctx.readAsObject();
		const deadline = Date.now() + 120000;

		const collect = () => {
			const pos = events.findIndex(e => e.id >= since);
			return {
				runId: RUN_ID,
				events: pos < 0 ? [] : events.slice(pos),
				next: eventId,
			};
		};

		let id = events.at(-1)?.id;
		if ((id == null || id < since) && (runId === RUN_ID)) {
			await new Promise(resolve => {
				const timer = setTimeout(done, deadline - Date.now());
				function done() {
					clearTimeout(timer);
					waiters.delete(done);
					resolve();
				}
				waiters.add(done);
			});
		}

		ctx.send(200, collect());
	});

	/**
	 * 统一执行命令并限制输出大小，按到达顺序交错拼接 stdout/stderr
	 * @param {string} command     - 要执行的程序或 shell 命令
	 * @param {string[]} args      - 程序参数（shell 模式时传空数组）
	 * @param {object}   options   - { cwd, timeout(ms), shell(boolean|string), safeCwd(用于落盘) }
	 * @returns {Promise<{code: number, text: string}>}
	 */
	async function executeCommand(command, args, { cwd, timeout, shell = false, dir = '.', inline, async: isAsync, env, kill, stdin = true }) {
		const child = spawn(command, args, {
			cwd,
			stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			shell,
			// POSIX 下让子进程成为进程组组长，killProcess 才能用 -pid 杀掉整棵树
			detached: !IS_WIN,
			env: {
				...process.env,
				...env
			}
		});

		let head = Buffer.alloc(0), tail = Buffer.alloc(0);
		let totalBytes = 0;

		let filename = `/pid-${child.pid}-${Math.random().toString(36).slice(3, 7)}.log`;
		let file = null;

		const createLogStream = () => {
			file = createWriteStream(path.join(cwd, filename), { flags: 'w' });
			file.on('error', (err) => {
				child.stdout.unpipe(file);
				child.stderr.unpipe(file);
				console.error("[进程] 日志写入失败", err);
				file = devNull();
			});
		};

		/** @param {Buffer} chunk */
		const onData = (chunk) => {
			totalBytes += chunk.length;

			if (file) {
				if (file.writableEnded) return;

				file.write(chunk);
				tail = Buffer.concat([tail, chunk]).subarray(-HALF);
			} else {
				tail = Buffer.concat([tail, chunk]);
				if (!inline && tail.length > OUTPUT_LIMIT) {
					createLogStream();
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

		const startTime = Date.now();
		let notify = false;

		const result = await new Promise((resolve) => {
			let timer = setTimeout(() => {
				child.stdout.removeAllListeners('data');
				child.stderr.removeAllListeners('data');

				if (kill) {
					killProcess(child);
					resolve({
						code: 'TIMEOUT, killed (pid='+child.pid+', logPath='+JSON.stringify(dir + filename)+')',
						text: getLog(),
					});
					return;
				}

				resolve({
					code: (isAsync?'':'TIMEOUT, ')+'Running in background (pid='+child.pid+', logPath='+JSON.stringify(dir + filename)+')',
					text: getLog(),
				});

				if (!file) createLogStream();

				file.write(tail);
				head = tail = null;
				notify = true;

				child.stdout.pipe(file, { end: false });
				child.stderr.pipe(file, { end: false });
			}, Math.min(isAsync ? 100 : timeout, 275000));

			if (!inline && child.pid != null)
				processes.set(child.pid, { child, logFile: dir+filename, cwd, timer });

			console.log("[进程] 已启动", child.pid, command, args);

			child.on('error', (err) => {
				clearTimeout(timer);
				if (!inline) processes.delete(child.pid);
				resolve({ code: -1, text: err.message });
			});

			child.on('exit', (code, signal) => {
				const info = !inline ? processes.get(child.pid) : null;
				if (!inline) processes.delete(child.pid);

				file?.end();
				clearTimeout(timer);

				const codeStr = signal || "0x"+code.toString(16);
				console.log("[进程] 已停止", child.pid, codeStr);

				if (notify) {
					fs.stat(dir+filename).catch(() => ({})).then(async state => {
						let logFile = dir+filename;
						if (state.size === 0) {
							await fs.rm(logFile).then(() => logFile = '0B, deleted', () => {});
						}
						postEvent('process-exit', {
							pid: child.pid,
							code: codeStr,
							logFile,
							message: !info ? true : info?.message
						});
					});
					processes.delete(child.pid);
				}

				if (head == null) return;

				resolve({
					code: codeStr,
					text: getLog()
				});
			});
		});

		return { code: result.code ?? 0, text: result.text.replaceAll(ANSI_SEQ, ""), duration: Date.now() - startTime };
	}

	/**
	 * 终止后台程序
	 */
	router.post('/kill', async (ctx) => {
		const { pid, message } = await ctx.readAsObject();
		const info = processes.get(pid);

		if (!info) return sendText(ctx.res, `Error: process died or not started by agent.`);

		const { child, logFile, timer } = info;

		if (child.exitCode !== null || child.signalCode != null) {
			processes.delete(pid);
			return sendText(ctx.res,
				`status: exited earlier
exitCode: ${child.exitCode}
logPath: ${logFile}`
			);
		}

		clearTimeout(timer);
		if (!message) {
			processes.delete(pid);
			info.message = true;
		} else {
			info.message = message;
		}
		await killProcess(child);

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
	let rgUsable = true;

	router.post('/grep', async (ctx) => {
		const body = await ctx.readAsObject();
		let { glob = "**", } = body;
		if (glob.startsWith("*.") && !glob.includes('/')) glob = "**/"+glob;

		rgNotUsable:
		if (rgUsable && glob.includes("**")) {
			const {
				pattern,
				path = ".",
				context = 0,
				maxFiles = 50,
				maxMatchesPerFile = 10,
			} = body;

			const cwd = pathFilter(path, ctx);
			try {
				if (!(await fs.stat(cwd)).isDirectory()) break rgNotUsable;
			} catch {
				break rgNotUsable;
			}

			const args = [
				//"-i", // --ignore-case
				"-n", // --line-number
				"--no-require-git",
				"--no-messages",
				"--heading",
				"-M", GREP_MAX_COLUMNS,
				"--max-columns-preview",
				"--color", "never",
				"--field-match-separator", "\x1f",
				//"--field-context-separator", "-",
				//"--context-separator", "--",

				// 这是一个trick，传入glob的同时让rg遵守.ignore规则
				"--glob-case-insensitive",
				"--type-add",
				"foo:"+glob,
				"-tfoo",

				"-m", maxMatchesPerFile,
				"-C", context,
				"--path-separator", "/",
				"--engine", "auto",
				"--",
				pattern
			];

			let { code, text } = await executeCommand(rgPath, args, {
				cwd,
				inline: true,
				stdin: false,
				timeout: 15000,
				kill: true,
				charset: 'utf8'
			});

			// ENOENT
			if (code === -1) {
				rgUsable = false;
				break rgNotUsable;
			}

			const arr = text.split("\n\n");
			return sendText(ctx.res, (arr.length === 1 ? arr[0] : arr.length < maxFiles ? text : arr.slice(0, maxFiles).join("\n\n")) || '[No match]');
		}

		sendText(ctx.res, await teh.grep(body, ctx));
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

		router.post('/feed', async (ctx) => {
			const { pid, content } = await ctx.readAsObject();
			const info = processes.get(pid);

			if (!info) return sendText(ctx.res, `Error: process died or not started by agent.`);

			const { child, logFile, timer } = info;
			child.stdin.write(content);

			sendText(ctx.res, `Successfully written, read ${logFile} for new output.`);
		});

		router.post('/spawn', async (ctx) => {
			const {
				program, arguments: args, cwd = '',
				timeout = 10, async = false,
				charset = 'utf8',
				env
			} = await ctx.readAsObject();
			const { code, text, duration } = await executeCommand(program, args, {
				cwd: await pathFilterWithIgnore(ctx, cwd, true),
				timeout: timeout * 1000,
				async,
				charset,
				env
			});
			sendText(ctx.res, `${typeof code === 'number'?'Exit code '+code:code} (wall time ${(duration/1000).toFixed(1)}s)\n${text}`);
		});

		router.post('/shell', async (ctx) => {
			let {
				command, cwd = '', shell = defaultShell,
				timeout = 10, async = false,
				charset = 'utf8',
				env
			} = await ctx.readAsObject();
			let args = [];

			if (shell === 'bashemu') {
				shell = false;
				args = ['-c', command];
				command = bashPath;
			}

			let { code, text, duration } = await executeCommand(command, args, {
				cwd: await pathFilterWithIgnore(ctx, cwd, true),
				timeout: timeout * 1000,
				async,
				shell,
				charset,
				env
			});
			if (globalThis.AIChatArgs.hideUser) text = text.replaceAll(new RegExp("\\b"+process.env.USERNAME+"\\b", "g"), "user");
			sendText(ctx.res, `${typeof code === 'number'?'Exit code '+code:code} (wall time ${(duration/1000).toFixed(1)}s)\n${text}`);
		});
	}
}