import {initServer} from "./init.js";
import {createSyncManager} from "./sync.js";
import {WebSocketServer} from "ws";

/**
 * 创建 Vite 插件，将匹配的请求转发给统一的 Router 处理。
 * @returns {import('vite').Plugin}
 */
export function serverDevPlugin({prefix = '/api'} = {}) {
	return {
		name: 'server-dev',
		async configureServer(server) {
			const router = await initServer("data");

			const wss = new WebSocketServer({ noServer: true });
			createSyncManager(wss);

			// 监听原生 HTTP Server 的 upgrade 事件
			server.httpServer.on('upgrade', (request, socket, head) => {
				const url = new URL(request.url, `http://${request.headers.host}`);

				if (url.pathname === "/api/sync") {
					wss.handleUpgrade(request, socket, head, (ws) => {
						wss.emit('connection', ws, request);
					});
				}
			});

			server.middlewares.use(async (req, res, next) => {
				const originalUrl = req.url;
				if (!originalUrl.startsWith(prefix)) return next();

				req.url = "/api"+originalUrl.slice(prefix.length);
				try {
					await router.handle(req, res);
				} finally {
					// 恢复原始 URL（某些后续中间件可能需要）
					req.url = originalUrl;
				}
			});
		}
	};
}