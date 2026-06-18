import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readBOM} from "../../common/chardet.js";
import iconv from "iconv-lite";
import {getEnvironmentPrompt} from "../utils/checkEnv.js";
import {createHashLine} from "../../common/hash-line.js";
import {createReadStream, createWriteStream} from 'node:fs';
import {pipeline} from "node:stream/promises";

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

	const text = tryDecode(buffer, 'UTF-8') || tryDecode(buffer, 'GB18030');
	if (text == null) throw "[Cannot read binary file]";
	return text;
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
export async function registerFsRoutes(router, allowExec) {
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

	router.post('/root', (ctx) => {
		sendText(ctx.res, ctx.sandboxRoot);
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
		const safePath = pathFilter(ctx, path);

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
		sendText(ctx.res, "done");
	});

	router.post('/readImage', async (ctx) => {
		const { path: filePath } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const stats = await fs.stat(safePath);
		if (stats.size > 10485760) {
			return ctx.send(400, { error: `File too big (${stats.size} bytes)` });
		}

		const ext = safePath.slice(safePath.lastIndexOf('.') + 1).toLowerCase();

		if (['png', 'jpg', 'bmp', 'jpeg', 'webp'].includes(ext)) {
			ctx.res.writeHead(200, {
				'Content-Type': `image/${ext}`,
				'Content-Length': stats.size,
			});

			return pipeline(createReadStream(safePath), ctx.res);
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
		const { path: filePath, glob = '*', json = false } = await ctx.readAsObject();
		const safePath = pathFilter(ctx, filePath);
		const entries = glob !== '*'
			? await fs.glob(glob, { cwd: safePath, withFileTypes: true })
			: await fs.readdir(safePath, { withFileTypes: true });

		let prefix = '';
		let items = 0;

		const MAX_COUNT = 500;
		const result = [];
		for await (const entry of entries) {
			if (items >= MAX_COUNT) {
				prefix = `[TRUNCATED: Only first ${MAX_COUNT} files shown, use a more specific glob or path]\n`;
				break;
			}

			const name = glob !== '*' ? path.join(entry.parentPath, entry.name).slice(safePath.length+1).replaceAll("\\", '/') : entry.name;
			if (entry.isFile()) {
				const fullPath = path.join(entry.parentPath, entry.name);
				const stats = await fs.stat(fullPath);

				result.push([name, "file", stats.size]);
			} else if (name) {
				// 跳过 '.' 当前目录
				result.push([name, "dir"]);
			}
		}

		if (json) {
			ctx.send(200, result);
			return;
		}

		sendText(ctx.res, result.length ? prefix+result.map(item => item.join("\t")).join("\n") : "[No result]");
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
		console.log("正在检测环境，这可能需要几秒钟（特别是容器内）...");
		const envPrompt = await getEnvironmentPrompt();
		console.log(envPrompt);

		let defaultShell = 'bash';
		if (envPrompt.startsWith("os: Windows")) {
			defaultShell = envPrompt.includes("bash: No") ? 'powershell' : "bashemu";
		}

		console.log("\n默认 shell: "+defaultShell);

		router.get('/env', async (ctx) => {
			return ctx.send(200, { prompt: envPrompt })
		});

		const OUTPUT_LIMIT = 20000;
		const HALF = Math.floor(OUTPUT_LIMIT / 2);

		/**
		 * 统一执行命令并限制输出大小，按到达顺序交错拼接 stdout/stderr
		 * @param {string} command     - 要执行的程序或 shell 命令
		 * @param {string[]} args      - 程序参数（shell 模式时传空数组）
		 * @param {object}   options   - { cwd, timeout(ms), shell(boolean|string), safeCwd(用于落盘) }
		 * @returns {Promise<{code: number, text: string}>}
		 */
		async function executeCommand(command, args, { cwd, timeout, shell = false, dir, noTruncate = false }) {
			const child = spawn(command, args, {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: shell || false,            // 为字符串时 spawn 会将其作为 shell 路径
			});

			let head = '', tail = '';
			let totalChars = 0;

			let filename = '';
			let file = null;

			/** @param {string} chunk */
			const onData = (chunk) => {
				totalChars += chunk.length;

				if (file) {
					file.write(chunk);
					tail = (tail + chunk).slice(-HALF);
				} else {
					tail += chunk;
					if (!noTruncate && tail.length > OUTPUT_LIMIT) {
						filename = `/command-log-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.log`;

						file = createWriteStream(path.join(cwd, filename), { flags: 'w' });
						file.write(tail);

						head = tail.slice(0, HALF);
						tail = tail.slice(-HALF);
					}
				}
			};

			child.stdout.on('data', (data) => onData(data.toString()));
			child.stderr.on('data', (data) => onData(data.toString()));

			// 进程结束（含超时）处理
			const result = await new Promise((resolve) => {
				let timer = setTimeout(() => child.kill('SIGTERM'), timeout);

				child.on('error', (err) => {
					clearTimeout(timer);
					resolve({ code: -1, text: err.message });
				});

				child.on('close', (code, signal) => {
					clearTimeout(timer);
					let text;
					if (!file) {
						text = tail;
					} else {
						if (file) file.end();
						text = head
							+ `\n<Output too large (${totalChars} chars). Full output saved to: ${JSON.stringify(dir+filename)}>\n`
							+ tail;
					}
					resolve({ code: signal ? "TIMEOUT" : code, text });
				});
			});

			return { code: result.code ?? 0, text: result.text };
		}

		router.post('/spawn', async (ctx) => {
			const { program, arguments: args, cwd = '', timeout = 10, noTruncate = false } = await ctx.readAsObject();
			const { code, text } = await executeCommand(program, args, {
				cwd: pathFilter(ctx, cwd),
				noTruncate,
				dir: '.',
				timeout: timeout * 1000,
				shell: false,
			});
			sendText(ctx.res, `Exit code ${code}\n${text}`);
		});

		router.post('/shell', async (ctx) => {
			let { command, cwd = '', timeout = 10, shell = defaultShell } = await ctx.readAsObject();
			let args = [];

			if (shell === 'bashemu') {
				shell = false;
				args = ['-c', command];
				command = 'bash';
			}

			const { code, text } = await executeCommand(command, args, {
				cwd: pathFilter(ctx, cwd),
				dir: '.',
				timeout: timeout * 1000,
				shell,
			});
			sendText(ctx.res, `Exit code ${code}\n${text}`);
		});

		// 后台进程管理：输出全部落盘为日志文件，LLM 可自行 read_file 查看
		/** @type {Map<string, {child: import('node:child_process').ChildProcess, logFile: string, cwd: string, timer?: number}>} */
		const bgProcesses = new Map();

		/**
		 * 启动后台程序（非阻塞），stdout/stderr → 日志文件
		 * @returns {string} 纯文本：id 与日志路径，LLM 用 read_file 自行查看
		 */
		router.post('/run_bg', async (ctx) => {
			const { program, arguments: args, cwd = '', timeout = -1 } = await ctx.readAsObject();
			const safeCwd = pathFilter(ctx, cwd);

			const id = Math.random().toString(36).slice(2, 10);
			const logName = `bg-program-${id}.log`;
			const logPath = path.join(safeCwd, logName);
			const relLog = path.relative(ctx.sandboxRoot, logPath);

			const logStream = createWriteStream(logPath, { flags: 'w' });

			const child = spawn(program, args || [], {
				cwd: safeCwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: false,
			});

			child.stdout.pipe(logStream);
			child.stderr.pipe(logStream);

			let timer = timeout > 0 && setTimeout(() => child.kill('SIGTERM'), timeout * 1000);

			bgProcesses.set(id, { child, logFile: logPath, cwd: safeCwd, timer });
			console.log("[后台进程] 已启动 "+id, program, args, cwd);

			child.on('close', () => {
				logStream.end();
				clearTimeout(timer);
				console.log("[后台进程] 已结束 "+id);
			});
			child.on('error', () => logStream.end());

			sendText(ctx.res, JSON.stringify({
				status: "Running in background",
				programId: id,
				logFile: relLog
			}));
		});

		/**
		 * 终止后台程序
		 */
		router.post('/stop_bg', async (ctx) => {
			const { programId } = await ctx.readAsObject();
			const info = bgProcesses.get(programId);

			if (!info) {
				return sendText(ctx.res, `invalid id: ${programId}`);
			}

			const { child, logFile, cwd, timer } = info;
			const relLog = path.relative(ctx.sandboxRoot, logFile);

			if (child.killed || child.exitCode !== null) {
				bgProcesses.delete(programId);
				return sendText(ctx.res, JSON.stringify({
					status: "terminated earlier",
					exitCode: child.exitCode,
					logFile: relLog
				}));
			}

			console.log("[后台进程] 中止 "+programId);
			clearTimeout(timer);
			child.kill('SIGTERM');

			setTimeout(() => {
				try { child.kill('SIGKILL'); } catch {}
				bgProcesses.delete(programId);
			}, 3000);

			sendText(ctx.res, JSON.stringify({
				status: "killed",
				logFile: relLog
			}));
		});
	}
}