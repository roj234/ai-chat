import http from 'node:http';
import { parseArgs } from 'node:util';
import { URL } from 'node:url';
import apiHandler from './fs-api.js';
const base_uri = '/agent-api/v1/fs/';

// --- 参数解析 ---
const options = {
	root: { type: 'string', default: './data' },
	port: { type: 'string', default: '8000' },
};
const { values } = parseArgs({ options });
const PORT = parseInt(values.port);
const ROOT_DIR = values.root;

// 设置全局变量供 api.js 使用（符合解耦原则也可通过 context 传递）
process.env.APP_ROOT_DIR = ROOT_DIR;

function notFound() {
	const err = new Error("Not Found");
	err.statusCode = 404;
	throw err;
}

const server = http.createServer(async (req, res) => {
	// --- CORS 配置 ---
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', '*');

	if (req.method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	try {
		const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
		let path = parsedUrl.pathname;
		if (path.startsWith(base_uri)) path = path.substring(base_uri.length);
		else notFound();

		const query_parameter = Object.fromEntries(parsedUrl.searchParams);

		let post_data = {};
		if (req.method === 'POST') {
			const buffers = [];
			for await (const chunk of req) {
				buffers.push(chunk);
			}
			const rawBody = Buffer.concat(buffers).toString();
			if (rawBody) {
				try {
					post_data = JSON.parse(rawBody);
				} catch (e) {
					throw new Error('Invalid JSON payload');
				}
			}
		}

		const result = await apiHandler({ path, query_parameter, post_data });

		if (result == null) notFound();

		if (result._data) {
			res.writeHead(200, { 'Content-Type': result._mime || 'application/octet-stream' });
			res.end(result._data);
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result));
	} catch (err) {
		if (404 !== err.statusCode)
			console.error(err);

		res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			detail: err.message.replace(ROOT_DIR, ""),
			error: err.constructor.name
		}));
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`Server running at http://localhost:${PORT}`);
	console.log(`Root directory: ${ROOT_DIR}`);
});