import fsPromises from 'node:fs/promises';
import {pollInterval, sleep} from "./utils.js";

/** @type {AiChat.FunctionTool} */
export const WatchFile = {
	name: 'WatchFile',
	description: '等待文件出现或消失，也可要求文件达到最小大小或包含指定文本。',
	parameters: {
		type: "object",
		properties: {
			path: {
				type: 'string',
				description: '文件绝对路径 (操作系统中的, 使用 Shell 获取)',
			},
			state: {
				type: 'string',
				default: 'exists',
				enum: ['exists', 'missing'],
			},
			timeoutMs: {
				type: 'integer',
				default: 30000
			},
			minSize: {
				type: 'integer',
				description: '文件最小大小(字节)',
			},
			textContains: {
				type: 'string',
				description: '文件必须包含内容',
			},
			encoding: {
				type: 'string',
				description: '读取文本时使用的编码',
				default: 'utf-8'
			},
		},
		required: ["path"]
	},
	async script({ path: filePath, state = 'exists', timeoutMs = 30000, minSize, textContains, encoding = 'utf-8' }) {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			let fileExists = false;
			let fileSize = 0;

			try {
				const stat = await fsPromises.stat(filePath);
				if (stat.isFile()) {
					fileExists = true;
					fileSize = stat.size;
				}
			} catch {
				// 文件不存在
			}

			// 检查基本存在/缺失条件
			if (state === 'exists' && fileExists) {
				// 检查额外条件
				if (minSize != null && fileSize < minSize) {
					// 文件大小不足，继续等待
				} else if (textContains != null) {
					try {
						const content = await fsPromises.readFile(filePath, encoding);
						if (content.includes(textContains)) {
							return `文件已就绪: ${filePath} (${fileSize} 字节)`;
						}
					} catch {
						// 读取失败，继续等待
					}
				} else {
					return `文件已就绪: ${filePath} (${fileSize} 字节)`;
				}
			}

			if (state === 'missing' && !fileExists) {
				return `文件已消失: ${filePath}`;
			}

			await sleep(pollInterval);
		}

		return "等待超时";
	}
};