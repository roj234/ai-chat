// 这个是沙箱里的模块！
export * from "./comfyui.js";
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const randomSeed = () => Math.floor(Math.random() * 2 ** 32);

export const downloadAll = async (task, saveDir) => {
	await mkdir(saveDir, { recursive: true });
	const files = await task.done;
	const dup = new Set;
	const tasks = [];
	const results = [];
	for (let i = 0; i < files.length; i++) {
		const file = files[i];

		let n = 0;
		let name = file.name, name1 = name;

		const ext = path.extname(name);
		if (dup.has(name1)) name1 = name.slice(0, -ext.length)+'_'+(++n)+ext;

		tasks.push(file.get().then(blob => {
			return writeFile(path.join(saveDir, name1), blob).then(() => {
				results.push({ type: file.type, name: name1, size: blob.size });
			});
		}).catch((e) => {
			results.push({ type: file.type, name: name1, error: e });
		}));
	}

	await Promise.allSettled(tasks);
	return results;
};