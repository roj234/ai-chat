import net from 'node:net';
import {pollInterval, sleep} from "./utils.js";

/** @type {AiChat.FunctionTool} */
export const WatchSocket = {
	name: 'WatchSocket',
	description: '等待某个 TCP 端口开放或关闭，适合等本地服务启动、关闭或重启。',
	parameters: {
		type: 'object',
		properties: {
			host: {
				type: 'string',
				default: "127.0.0.1",
			},
			port: {
				type: 'integer',
				minimum: 1,
				maximum: 65535
			},
			state: {
				type: 'string',
				default: 'open',
				description: '期望的端口状态：`open` 等待端口开放，`closed` 等待端口关闭',
				enum: ['open', 'closed'],
			},
			timeoutMs: {
				type: 'integer',
				default: 30000,
				description: '最长等待时间（毫秒）',
			},
		},
		required: ['port']
	},
	async script({ host = '127.0.0.1', port, state = 'open', timeoutMs = 30000 }) {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const currentDeadline = Date.now() + pollInterval;
			const open = await new Promise((resolve) => {
				const sock = new net.Socket();
				sock.setTimeout(pollInterval);

				sock.on('connect', () => {
					sock.destroy();
					resolve(true);
				});

				sock.on('error', () => {
					sock.destroy();
					resolve(false);
				});

				sock.on('timeout', () => {
					sock.destroy();
					resolve(false);
				});

				try {
					sock.connect(port, host);
				} catch {
					resolve(false);
				}
			});
			if (state === 'open' && open) return `端口已开放: ${host}:${port}`;
			if (state === 'closed' && !open) `端口已关闭: ${host}:${port}`;

			const remain = currentDeadline - Date.now();
			if (remain > 0) await sleep(remain);
		}

		return "等待超时";
	}
};