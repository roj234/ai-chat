import {spawn} from "node:child_process";

export const IS_WIN = process.platform === 'win32';

/**
 * 结束进程树。
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [gracePeriod] SIGTERM 升级到 SIGKILL 的宽限期(ms)，0 表示立即升级
 * @returns {Promise<void>} Windows 下在 taskkill 返回后 resolve
 */
export function killProcess(child, gracePeriod = 3000) {
	const pid = child.pid;
	// 用 exitCode/signalCode 判断，child.killed 只代表"发过信号"
	if (pid == null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

	if (IS_WIN) {
		return new Promise((resolve) => {
			let settled = false;
			const done = (ok) => {
				if (settled) return;
				settled = true;
				if (!ok) try { child.kill('SIGKILL'); } catch {}
				resolve();
			};
			const killer = spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
			killer.on('error', () => done(false));
			killer.on('exit', (code) => done(code === 0));
		});
	}

	const sig = gracePeriod > 0 ? 'SIGTERM' : 'SIGKILL';
	try {
		process.kill(-pid, sig);
	} catch {
		try { child.kill(sig); } catch {}
	}
	if (gracePeriod <= 0) return Promise.resolve();

	const timer = setTimeout(() => {
		try { process.kill(-pid, 'SIGKILL'); } catch {
			try { child.kill('SIGKILL'); } catch {}
		}
	}, gracePeriod);
	timer.unref?.();

	return Promise.resolve();
}