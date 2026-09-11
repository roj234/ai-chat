import readline from 'node:readline';
import {generatePAT} from "../utils/PAT.js";
import {loadUserData} from "../utils/UserManager.js";

// ---------- 常量 ----------
const MAX_PENDING = 10;               // 同时等待的最大配对请求数
const PAIRING_TIMEOUT_MS = 60_000;    // 单个配对码的超时时间

// ---------- 内部状态 ----------
/** @type {Map<string, [resolve: () => void, reject: (err: Error) => void, timer: NodeJS.Timeout]>} */
const pendingMap = new Map();

// 惰性创建单例 readline 接口
let rl = null;
function initConsole() {
	if (!rl) {
		rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
			//terminal: true,
		});
		rl.on('line', (line) => handleLine(line.trim()));
	}
	return rl;
}

// ---------- 命令解析 ----------
const CMD_ACCEPT = /^\/accept\s+(\d{6})\s*$/;
const CMD_DENY   = /^\/deny\s+(\d{6})(?:\s+(.*))?$/;

/**
 * @param {string} line
 */
function handleLine(line) {
	let match;

	if ((match = line.match(CMD_ACCEPT))) {
		resolvePairing(match[1], null);
		return;
	}

	if ((match = line.match(CMD_DENY))) {
		const code = match[1];
		const reason = (match[2] || '').trim() || '拒绝配对';
		resolvePairing(code, new Error(reason));
		return;
	}

	console.log("无效的指令");
}

/**
 * @param {string} code
 * @param {Error|null} rejectReason - null 表示成功，否则为拒绝原因
 */
function resolvePairing(code, rejectReason) {
	const entry = pendingMap.get(code);
	if (!entry) {
		console.log("配对码错误或已超时");
		return;
	}

	const [resolve, reject, timer] = entry;

	clearTimeout(timer);
	pendingMap.delete(code);

	if (rejectReason) {
		console.log(`配对请求 #${code} 已拒绝`);
		reject(rejectReason);
	} else {
		console.log(`配对请求 #${code} 已接受`);
		resolve();
	}
}

/** @type {number} */
let lastPairingTime;

/**
 * @returns {string}
 */
function generatePairingCode() {
	let code;
	do {
		code = Math.floor(Math.random() * 999999).toString().padStart(6, '0');
	} while (pendingMap.has(code));
	return code;
}

/**
 * 发起一个交互式登录请求
 * @param {string} message
 * @returns {[string, Promise<void>, Function]}
 */
function interactiveLogin(message) {
	initConsole();
	const code = generatePairingCode();

	let resolve, reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});

	const timer = setTimeout(() => {
		pendingMap.delete(code);
		reject(new Error('超时：控制台无交互'));
	}, PAIRING_TIMEOUT_MS);

	pendingMap.set(code, [ resolve, reject, timer ]);

	// 控制台打印指引
	console.log(`\n🔐 新的配对请求`);
	console.log(message.split("\n").join("\n   "));
	console.log(`   接受: /accept ${code}`);
	console.log(`   拒绝: /deny ${code} [原因]`);
	console.log(`   (60 秒后自动拒绝)\n`);

	return [code, promise, () => {
		if (pendingMap.delete(code)) {
			console.log(`配对请求 #${code} 已取消`);
		}
	}];
}

/**
 * @param {AiChatBackend.Router} router
 * @param {string} dataPath
 */
export function registerPairingRoutes(router, dataPath) {
	router.post('/login', async (ctx) => {
		const userId = ctx.params.userId;
		if (!userId) return ctx.send(400, "");

		if (pendingMap.size >= MAX_PENDING) ctx.send(429, { error: `服务器繁忙，请稍后再试 (${MAX_PENDING})` });

		const timeLimiter = Math.trunc(Date.now() / 200);
		if (lastPairingTime === timeLimiter)  ctx.send(429, { error: `服务器繁忙，请稍后再试 (${timeLimiter})` });
		lastPairingTime = timeLimiter;

		let pairCode, pairPromise, cancel;
		try {
			const remoteAddress = ctx.req.socket.remoteAddress;
			const userAgent = ctx.req.headers['user-agent'];

			[pairCode, pairPromise, cancel] = interactiveLogin(`登录 ${JSON.stringify(userId)}\n
IP: ${remoteAddress}
UA: ${JSON.stringify(userAgent)}
备注: ${JSON.stringify(ctx.searchParams.get('desc'))}`);
		} catch (e) {
			return ctx.send(500, { error: e.message });
		}

		const res = ctx.res;

		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		res.write(`data: ${JSON.stringify({code: pairCode})}\n\n`);
		res.on('close', cancel);

		try {
			await pairPromise;
			loadUserData(dataPath, userId, ctx);
			const token = generatePAT(ctx, 1);
			console.log("生成PAT: ****"+token.slice(token.length-4));
			res.write(`data: ${JSON.stringify({token})}\n\n`);
		} catch (e) {
			res.write(`data: ${JSON.stringify({error: e.message})}\n\n`);
		}

		res.write(`data: [DONE]\n\n`);
		res.end();
	});
}