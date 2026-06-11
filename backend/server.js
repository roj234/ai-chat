import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import {watch} from 'fs';
import {parseArgs} from 'node:util';
import {initServer} from './init.js';
import {createSyncManager} from "./sync.js";
import {WebSocketServer} from "ws";
import {reload, WEBSOCKET_SYNC_ENABLE} from "./config.js";
import {createZipRouter} from "./utils/zipRouter.js";
import {closeAllConnections} from "./utils/UserManager.js";

const options = {
	addr: { type: 'string', short: 'a', default: '127.0.0.1' },
	port: { type: 'string', short: 'p', default: '3000' },
	cert: { type: 'string', default: '' },
	static: { type: 'string', default: '' },
	config: { type: 'string', short: 'c', default: './config.js' },
	data: { type: 'string', default: 'data' },
	workspace: { type: 'string', default: '' },
};
const { values: {
	addr, port, cert,
	static: zipPath,
	config: configPath,
	data, workspace,
} } = parseArgs({ options });
const PORT = parseInt(port, 10);

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

async function fileWatcher(path, callback, uiName) {
	let retries = 0;
	const reloadFile = async () => {
		try {
			await callback(path, retries);
			if (retries) console.log("[reload] "+uiName+" 加载成功");
			retries = 0;
		} catch (e) {
			const timeout = 100 * Math.pow(2, retries++);
			if (retries > 7) throw e;
			setTimeout(reloadFile, timeout);
			console.error("[reload] "+uiName+" 加载失败, "+timeout+" ms后重试", e.code);
		}
	};
	await reloadFile();

	watch(path, (eventType) => {
		if (eventType === 'change') {
			if (!retries) {
				console.log("[reload] 正在重载 "+uiName);
				retries = 1;
				setTimeout(reloadFile, 100);
			}
		}
	});
}

try {
	await fileWatcher(configPath, async (configPath) => {
		configPath += '?t='+(await fs.stat(configPath)).mtimeMs;
		reload(configPath);
	}, "配置文件");
} catch (e) {
	console.error("[config] 配置文件加载失败");
	console.error(e);
	process.exit(1);
}

const apiRouter = await initServer(data, "api", workspace);

if (zipPath) {
	await fileWatcher(zipPath, async (zipPath) => {
		const fileBuffer = await fs.readFile(zipPath);
		apiRouter.zipRouter = await createZipRouter(fileBuffer);
	}, "前端");
}

const server = serverType.createServer(serverOptions, (req, res) => apiRouter.handle(req, res));
if (WEBSOCKET_SYNC_ENABLE) {
	const wss = new WebSocketServer({ server, path: "/api/sync", maxPayload: 131072 });
	createSyncManager(wss);
}

server.listen(PORT, addr, () => {
	console.log(`
   █████╗ ██╗ ██████╗██╗  ██╗ █████╗ ████████╗
  ██╔══██╗██║██╔════╝██║  ██║██╔══██╗╚══██╔══╝
  ███████║██║██║     ███████║███████║   ██║   
  ██╔══██║██║██║     ██╔══██║██╔══██║   ██║   
  ██║  ██║██║╚██████╗██║  ██║██║  ██║   ██║   
  ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   v{{PROJECT_VERSION}}

  >> 理性之人使自己适应世界，不理性之人坚持要世界适应自己。因此，一切进步都依赖于不理性之人。 —— 萧伯纳
  >> Copyright (c) 2025-2026 Roj234

  Build:    {{BUILD_TIME}} (commit: {{GIT_COMMIT}})`);
	console.log(`  Status:   Listening on http://${addr}:${PORT}`);
	if (workspace) {
		console.log(`  Mode:     Containerd in ${JSON.stringify(workspace)}`);
		return;
	}
	console.log(`  Mode:     Database service in ${data === '' ? 'memory' : JSON.stringify(data)}`);
	console.log(`  Frontend: ${zipPath?"bundled":"no"}`);
});

// 封装一个优雅退出的函数
function gracefulShutdown() {
	console.log('[shutdown] 正在关闭数据库...');
	closeAllConnections();
	process.exit(0);
}

// 监听 Ctrl+C (SIGINT)
process.on('SIGINT', gracefulShutdown);
// 监听 Kill 命令 (SIGTERM)
process.on('SIGTERM', gracefulShutdown);
// screen4w
process.on('message', (m) => {
	console.log("[shutdown] IPC message", m);
	if (m === "shutdown") gracefulShutdown();
});