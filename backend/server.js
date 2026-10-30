import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import path from "node:path";
import {parseArgs} from 'node:util';
import {spawn} from "node:child_process";

import {WebSocketServer} from "@roj234/ws";
import {ZipReader} from "unconscious/common/zip-io.js";

import "./utils/log-hook.js";
import "./utils/fetch-hook.js";

import {
	FS_SERVICE_PAT,
	INSTANCE_ID,
	INTERACTIVE_LOGIN,
	PAT_SERVER_SALT,
	reload,
	SERVER_BASE_ADDR,
	WEBSOCKET_SYNC_ENABLE
} from "./config.js";
import {debugSecret} from "./utils/debugSecret.js";
import {PROTOCOL_VERSION} from "./sync.js";

import {createRouter} from './init.js';
import {createSyncManager, createSyncValidateMiddleware} from "./syncServer.js";
import {createZipRouter} from "./utils/zipRouter.js";
import {closeAllConnections} from "./utils/UserManager.js";
import {isLanAddress} from "../common/isLanAddress.js";

const shutdownHooks = [];
globalThis.AiChatAPI.addShutdownHook = (hook) => shutdownHooks.push(hook);

const options = {
	addr: { type: 'string', short: 'a', default: '127.0.0.1' },
	port: { type: 'string', short: 'p', default: '3000' },
	cert: { type: 'string', default: '' },
	static: { type: 'string', default: '' },
	'no-sandbox': { type: 'boolean', default: false },
	'hide-user': { type: 'boolean', default: false },
	config: { type: 'string', short: 'c', default: './config.js' },
	data: { type: 'string', default: 'data' },
	workspace: { type: 'string', default: '' },
};
const { values: {
	addr, port, cert,
	static: zipPath,
	config: configPath,
	data, workspace,
	'no-sandbox': noSandbox, 'hide-user': hideUser
} } = parseArgs({ options });
const PORT = parseInt(port, 10);
const DATA_PATH = path.resolve(data);

let serverType;
let serverOptions;

if (cert) {
	serverType = https;
	serverOptions = {
		key: await fs.readFile(cert+'.key'),
		cert: await fs.readFile(cert+'.crt')
	}
} else {
	serverType = http;
	serverOptions = {}
}

async function fileWatcher(path, callback, uiName, noInitial) {
	let hasPendingEvent = false;
	let loading = false;

	const reloadFile = async () => {
		try {
			await callback(path, hasPendingEvent);
		} catch (e) {
			console.error("[reload] "+uiName+"重载失败", e);
			if (hasPendingEvent) {
				hasPendingEvent = false;
				timeout = setTimeout(reloadFile, 100);
				return;
			}
		}

		if (loading) console.log("[reload] "+uiName+"重载成功");
		loading = false;
	};
	if (!noInitial) await reloadFile();

	let timeout;
	watch(path, (eventType) => {
		if (eventType === 'change') {
			if (!loading) {
				clearTimeout(timeout);
				timeout = setTimeout(() => {
					loading = true;
					console.log("[reload] 正在重载"+uiName);
					reloadFile();
				}, 100);
				return;
			}
			hasPendingEvent = true;
		}
	});
}

try {
	await fileWatcher(configPath, async (configPath) => {
		await reload("./config.default.js");
		await reload(configPath+'?t='+(await fs.stat(configPath)).mtimeMs);

		const repl = [];

		if (INTERACTIVE_LOGIN && !PAT_SERVER_SALT) repl.push(['PAT_SERVER_SALT', crypto.randomUUID()]);
		if (!INSTANCE_ID) repl.push(['INSTANCE_ID', crypto.randomUUID()]);

		if (repl.length) {
			let js = await fs.readFile(configPath, 'utf-8');
			for (const [k, v] of repl) {
				const initJs = js;
				js = js.replace(new RegExp(`\\b${k}\\s*=\\s*(['"\`])\\1`), `${k} = '${v}'`);

				if (initJs === js) {
					console.error(`[config] 配置文件缺少键 ${k} 可能需要自行从 default 迁移。`);
					process.exit(1);
				}
			}

			await fs.writeFile(configPath, js, 'utf-8');
			await reload(configPath+'?t='+(await fs.stat(configPath)).mtimeMs);
		}

	}, "配置文件");
} catch (e) {
	console.error("[config] 配置文件加载失败");
	console.error(e);
	process.exit(1);
}

if (!isLanAddress(addr)) {
	if (workspace) {
		if (!FS_SERVICE_PAT)
			throw new DOMException("监听地址不是内网，必须配置 FS_SERVICE_PAT");
	} else if (!INTERACTIVE_LOGIN) {
		throw new DOMException("监听地址不是内网，必须配置 INTERACTIVE_LOGIN");
	}
}

const router = await createRouter(DATA_PATH, "api", workspace);

let frontendVersion = 'bundled';
if (zipPath) {
	router.get("/", (ctx) => {
		if (SERVER_BASE_ADDR) ctx.res.setHeader('X-AiChat-API', SERVER_BASE_ADDR);
		return router.zipRouter(ctx);
	})

	await fileWatcher(zipPath, async (zipPath) => {
		const fileBuffer = await fs.readFile(zipPath);
		const zip = await ZipReader(fileBuffer);
		const meta = await zip.getText("/INFO");
		if (meta) {
			const ver = JSON.parse(meta);
			frontendVersion = ver.v;
			if (ver.b) frontendVersion += " (b"+ver.b+")";
			if (ver.t) frontendVersion += " 构建于 "+new Date(ver.t).toISOString();
		}

		router.zipRouter = createZipRouter(zip);
	}, "前端");
}

const restart = (mainEntry) => new Promise((resolve, reject) => {
	const args = [...process.execArgv, mainEntry, ...process.argv.slice(2)];
	const child = spawn(process.execPath, args, {
		stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
		env: {...process.env, AINT_UPDATE: '1'},
		cwd: process.cwd(),
	});

	child.on('message', async (msg) => {
		if (msg !== 'ready') return;
		resolve();
		await closeServer();
		child.send('go', () => process.exit(0));
	});

	setTimeout(() => {
		child.kill();
		reject("[update] 子进程未能及时启动");
	}, 9500);
});

if (process.env.AINT_AUTORESTART) {
	await fileWatcher(process.argv[1], restart, "软件", true);

	if (debugSecret) {
		router.get(`/${debugSecret}/restart`, () => {
			console.log("调试接口触发重启");
			return restart(process.argv[1]);
		});
	}
}

const server = serverType.createServer(serverOptions, (req, res) => router.handle(req, res));
if (WEBSOCKET_SYNC_ENABLE) {
	const wss = new WebSocketServer({
		server,
		path: "/api/sync",
		maxPayload: 4096,
		verifyClient: createSyncValidateMiddleware(DATA_PATH),
		perMessageDeflate: true
	});
	router.sync = createSyncManager(wss);
}

globalThis.AIChatArgs = {
	noSandbox,
	hideUser
}

// 自动更新
if (process.env.AINT_UPDATE === '1' && process.connected) {
	console.log("[update] 等待父进程退出")
	await new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			process.off('message', onMessage);
			process.off('disconnect', done);
			resolve();
		};
		const timer = setTimeout(done, 10000);
		const onMessage = (message) => {
			if (message === 'go') done();
		};
		process.on('message', onMessage);
		process.once('disconnect', done);
		try {
			process.send?.('ready');
		} catch {
			// 旧进程已经退出（IPC 通道已关闭），直接接管
			done();
		}
	});
}

server.listen(PORT, addr, () => {
	console.log(`
   █████╗ ██╗ ██████╗██╗  ██╗ █████╗ ████████╗
  ██╔══██╗██║██╔════╝██║  ██║██╔══██╗╚══██╔══╝
  ███████║██║██║     ███████║███████║   ██║   
  ██╔══██║██║██║     ██╔══██║██╔══██║   ██║   
  ██║  ██║██║╚██████╗██║  ██║██║  ██║   ██║   
  ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   v{{PROJECT_VERSION}} (Protocol ${PROTOCOL_VERSION})

  >> 理性之人使自己适应世界，不理性之人坚持要世界适应自己。因此，一切进步都依赖于不理性之人。 —— 萧伯纳
  >> Copyright (c) 2025-2026 Roj234

  构建于:   {{BUILD_TIME}} (commit: {{GIT_COMMIT}})`);
	console.log(`  地址:     http${cert?'s':''}://${addr}:${PORT}`);
	if (workspace) {
		console.log(`  模式:     专用文件访问服务，位于 ${JSON.stringify(workspace)}`);
		if (noSandbox) console.log(`  (沙盒已禁用)`);
		return;
	}
	console.log(`  模式:     数据库服务，位于 ${data === '' ? '内存' : JSON.stringify(data)}`);
	console.log(`  内置前端: ${zipPath?frontendVersion:"无"}`);
});

async function closeServer() {
	console.log('[shutdown] 正在退出...');
	const result = await Promise.allSettled([
		...shutdownHooks.map(fn => fn()),
		closeAllConnections(),
		new Promise((resolve) => {
			if (!server.listening) return resolve();
			server.close(() => resolve());
			server.closeAllConnections();
		})
	]);
	for (const item of result) {
		const error = item.reason;
		if (error) console.error('[shutdown]', error);
	}
}

// 封装一个优雅退出的函数
const gracefulShutdown = () => closeServer().then(() => process.exit(0));

// 监听 Ctrl+C (SIGINT)
process.on('SIGINT', gracefulShutdown);
// 监听 Kill 命令 (SIGTERM)
process.on('SIGTERM', gracefulShutdown);
// screen4w
process.on('message', (m) => {
	console.log("[shutdown] IPC message", m);
	if (m === "shutdown") gracefulShutdown();
});