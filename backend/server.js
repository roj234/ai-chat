import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {initServer} from './init.js';
import {createSyncManager} from "./sync.js";
import {WebSocketServer} from "ws";
import {WEBSOCKET_SYNC_ENABLE} from "./config.js";

const options = {
	port: { type: 'string', short: 'p', default: '3000' },
	data: { type: 'string', default: 'data' },
	static: { type: 'string', default: '' },
	cert: { type: 'string', default: '' },
};
const { values: { port, data, cert, static: zipPath } } = parseArgs({ options });
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

let zipBlob;
if (zipPath) {
	const fileBuffer = await fs.readFile(zipPath);
	zipBlob = new Blob([fileBuffer], { type: 'application/zip' });
}

const apiRouter = initServer(data, "aichat/v2", zipBlob);

const server = serverType.createServer(serverOptions, (req, res) => apiRouter.handle(req, res));
if (WEBSOCKET_SYNC_ENABLE) {
	const wss = new WebSocketServer({ server, path: "/aichat/v2/sync", maxPayload: 4096 });
	createSyncManager(wss);
}

server.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}/`);
	console.log(`Data Path: ${data === '' ? 'In-Memory' : data}`);
	console.log(`Zip Path: ${zipPath}`);
});