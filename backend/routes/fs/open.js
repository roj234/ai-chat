import fs from "node:fs";
import path from "node:path";
import {spawn} from "node:child_process";

/**
 * 在系统文件管理器中打开路径
 * @param {string} target 目录或文件
 * @param {{reveal?: boolean}} [opts] 在父目录中选中该文件
 * @return {Promise<boolean>}
 */
export function showFile(target, { reveal = false } = {}) {
	const abs = path.resolve(target);
	if (!fs.existsSync(abs)) throw new DOMException(`路径不存在: ${abs}`, 'NotFoundError');

	let cmd, args;
	if (process.platform === 'win32') {
		cmd = 'explorer.exe';
		args = reveal ? [`/select,${JSON.stringify(abs)}`] : [abs];
	} else if (process.platform === 'darwin') {
		cmd = 'open';
		args = reveal ? ['-R', abs] : [abs];
	} else {
		/*cmd = 'dbus-send';
		args = [
			'--session', '--dest=org.freedesktop.FileManager1', '--type=method_call',
			'/org/freedesktop/FileManager1',
			'org.freedesktop.FileManager1.ShowItems',
			`array:string:${pathToFileURL(abs).href}`, 'string:'
		];*/
		cmd = 'xdg-open';
		args = [reveal ? path.dirname(abs) : abs];
	}

	return new Promise((resolve) => {
		const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
		child.on('error', (err) => resolve(false));
		child.on('exit', (code) => resolve(true));
		child.unref();
	});
}
