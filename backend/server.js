import http from 'node:http';
import {parseArgs} from 'node:util';
import {initServer} from './init.js';
import {createSyncManager} from "./sync.js";
import {WebSocketServer} from "ws";
import {WEBSOCKET_SYNC_ENABLE} from "./config.js";

const options = {
	port: { type: 'string', short: 'p', default: '3000' },
	data: { type: 'string', default: 'data' },
};
const { values: args } = parseArgs({ options });
const PORT = parseInt(args.port, 10);
const DATA_PATH = args.data;

const router = initServer(DATA_PATH);

const server = http.createServer((req, res) => router.handle(req, res));
if (WEBSOCKET_SYNC_ENABLE) {
	const wss = new WebSocketServer({ server, path: "/aichat/v2/sync", maxPayload: 4096 });
	createSyncManager(wss);
}

server.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}/`);
	console.log(`DATA PATH: ${DATA_PATH === '' ? 'In-Memory' : DATA_PATH}`);
});