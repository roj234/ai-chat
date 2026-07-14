import {exec} from 'node:child_process';
import {IS_WINDOWS, pollInterval, sleep, toolError} from "./utils.js";

/** @type {AiChat.FunctionTool} */
export const WatchProcess = {
	name: 'WatchProcess',
	description: '等待进程运行或退出。',
	parameters: {
		type: 'object',
		properties: {
			pid: {
				type: 'integer',
				description: '可选，指定 PID',
			},
			name: {
				type: 'string',
				description: '可选，指定进程名',
			},
			state: {
				type: 'string',
				description: '期望的进程状态：`running` 等待进程在运行，`exited` 等待进程退出',
				default: 'running',
				enum: ['running', 'exited'],
			},
			timeoutMs: {
				type: 'integer',
				default: 30000,
			},
		},
		required: []
	},
	async script({ pid, name, state = 'running', timeoutMs = 30000 }) {
		if (pid == null && !name) {
			return toolError('错误：`pid` 和 `name` 至少需要提供一个');
		}
		if (state === 'running' && pid != null) {
			return toolError('错误：`pid` 无法与 running 状态一起使用，进程还没启动怎么知道 PID？');
		}

		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const running = await checkProcessRunning(pid, name);

			if (state === 'running' && running) {
				const label = pid != null ? `PID ${pid}` : `进程 "${name}"`;
				return `进程已运行: ${label}`;
			}

			if (state === 'exited' && !running) {
				const label = pid != null ? `PID ${pid}` : `进程 "${name}"`;
				return `进程已退出: ${label}`;
			}

			await sleep(pollInterval);
		}

		return "等待超时";
	}
};


/**
 * 检查指定 PID 的进程是否存在
 */
function pidExists(pid) {
	try {
		// signal 0 只检查进程是否存在，不实际发送信号（跨平台）
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * 按名称查找进程 PID 列表
 * - Windows: tasklist
 * - Unix: pgrep 或 ps
 */
async function findPidsByName(name) {
	if (IS_WINDOWS) {
		return new Promise((resolve) => {
			exec(`tasklist /FI "IMAGENAME eq ${name}" /NH /FO CSV`, { timeout: 5000 }, (err, stdout) => {
				if (err) return resolve([]);
				const pids = [];
				for (const line of stdout.split('\n')) {
					const match = line.match(/"([^"]+)"/g);
					if (match && match.length >= 2) {
						const pid = parseInt(match[1].replace(/"/g, ''), 10);
						if (pid) pids.push(pid);
					}
				}
				resolve(pids);
			});
		});
	} else {
		// Unix: 尝试 pgrep，失败则用 ps
		return new Promise((resolve) => {
			exec(`pgrep -x "${name}" 2>/dev/null || ps -eo pid,comm | grep -w "${name}" | awk '{print $1}'`, { timeout: 5000 }, (err, stdout) => {
				if (err) return resolve([]);
				const pids = stdout.trim().split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
				resolve(pids);
			});
		});
	}
}

/**
 * 检查是否有匹配条件的进程在运行
 */
async function checkProcessRunning(pid, name) {
	if (pid != null) {
		return pidExists(pid);
	}
	if (name != null) {
		const pids = await findPidsByName(name);
		return pids.length > 0;
	}
	return false;
}
