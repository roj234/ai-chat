import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import {watch} from 'fs';
import {parseArgs} from 'node:util';
import {closeAllConnections, initServer} from './init.js';
import {createSyncManager} from "./sync.js";
import {WebSocketServer} from "ws";
import {WEBSOCKET_SYNC_ENABLE} from "./config.js";
import {createZipRouter} from "./utils/zipRouter.js";

const options = {
	port: { type: 'string', short: 'p', default: '3000' },
	data: { type: 'string', default: 'data' },
	static: { type: 'string', default: '' },
	cert: { type: 'string', default: '' },
	workspace: { type: 'string', default: '' }
};
const { values: { port, data, cert, workspace, static: zipPath } } = parseArgs({ options });
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

const apiRouter = await initServer(data, "api", workspace);

if (zipPath) {
	let loading = 0;
	const loadFrontend = async () => {
		try {
			const fileBuffer = await fs.readFile(zipPath);
			apiRouter.zipRouter = await createZipRouter(fileBuffer);
			if (loading) console.log("前端文件重载成功");
			loading = 0;
		} catch (e) {
			const timeout = 100 * Math.pow(2, loading++);
			setTimeout(loadFrontend, timeout);
			console.error("前端文件加载失败，将在 "+timeout+" ms后重试", e.code);
		}
	};
	await loadFrontend();

	watch(zipPath, (eventType) => {
		if (eventType === 'change') {
			if (!loading) {
				console.log("正在重载前端");
				loading = 1;
				loadFrontend();
			}
		}
	});
}

const server = serverType.createServer(serverOptions, (req, res) => apiRouter.handle(req, res));
if (WEBSOCKET_SYNC_ENABLE) {
	const wss = new WebSocketServer({ server, path: "/api/sync", maxPayload: 131072 });
	createSyncManager(wss);
}

server.listen(PORT, () => {
	console.log(`
   █████╗ ██╗ ██████╗██╗  ██╗ █████╗ ████████╗
  ██╔══██╗██║██╔════╝██║  ██║██╔══██╗╚══██╔══╝
  ███████║██║██║     ███████║███████║   ██║   
  ██╔══██║██║██║     ██╔══██║██╔══██║   ██║   
  ██║  ██║██║╚██████╗██║  ██║██║  ██║   ██║   
  ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   v2.0.0

  >> 理性之人使自己适应世界，不理性之人坚持要世界适应自己。因此，一切进步都依赖于不理性之人。 —— 萧伯纳
  >> Copyright (c) 2025-2026 Roj234

  Build:    2026-05-31T12:04:53.322Z (commit: bff8bc0*)`);
	console.log(`  Status:   Listening on http://localhost:${PORT}`);
	if (workspace) {
		console.log(`  Mode:     Containerd in ${JSON.stringify(workspace)}`);
		return;
	}
	console.log(`  Mode:     Database service in ${data === '' ? 'memory' : JSON.stringify(data)}`);
	console.log(`  Frontend: ${zipPath?"bundled":"no"}`);
});

// 封装一个优雅退出的函数
function gracefulShutdown() {
	console.log('正在关闭数据库...');
	closeAllConnections();
	process.exit(0);
}

// 监听 Ctrl+C (SIGINT)
process.on('SIGINT', gracefulShutdown);
// 监听 Kill 命令 (SIGTERM)
process.on('SIGTERM', gracefulShutdown);
// screen4w
process.on('message', (m) => {
	console.log("IPC message", m);
	if (m === "shutdown") gracefulShutdown();
});