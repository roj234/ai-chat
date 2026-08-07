import {unconscious} from "unconscious";

export const createAsyncQueue = (concurrency = 6) => {
	const taskQueue = new Set;

	return [async runTask => {
		while (taskQueue.size >= concurrency) {
			await Promise.race(taskQueue);
		}

		const self = runTask().finally(() => taskQueue.delete(self));
		taskQueue.add(self);
	}, () => Promise.all(taskQueue)];
}

/**
 * 节流函数，保证最终一定会以最新的参数调用一次
 * @template {Function} T
 * @param {T} fn
 * @param {number} wait=300
 * @return {T}
 */
export const throttled = (fn, wait = 300) => {
	let timer;
	let latestArgs;
	const again = (...args) => {
		if (timer) {
			latestArgs = args;
		} else {
			timer = setTimeout(() => {
				timer = 0;
				fn(...args);
				if (latestArgs) {
					again(...latestArgs);
					latestArgs = 0;
				}
			}, wait);
		}
	};
	return again;
};

export const once = callback => {
	let result;
	return () => {
		if (callback) {
			result = callback();
			callback = null;
		}
		return result;
	}
};

/**
 * 只克隆指定名称
 * @param obj
 * @param {Set<string>|string[]} names
 * @return {{}}
 */
export const cloneNamed = (obj, names) => {
	const result = {};
	obj = unconscious(obj);
	for (const name of names) {
		if (name in obj) result[name] = obj[name];
	}
	return result;
};

export function limitMaxSide(width, height, maxSide) {
	if (width > maxSide || height > maxSide) {
		if (width > height) {
			height = (height / width) * maxSide;
			width = maxSide;
		} else {
			width = (width / height) * maxSide;
			height = maxSide;
		}
	}
	return [width, height];
}

/**
 * 压缩图片
 * @param {Blob} file - 输入的原始图片文件
 * @param {number=} quality - 压缩质量 (0-1)
 * @param {number=} maxSide - 长边限制
 * @param {number=} maxSize - 最大大小
 * @returns {Promise<Blob>} - 返回压缩后的 JPEG Blob
 */
export const compressImage = async (file, {quality = 0.85, maxSide = 2048, maxSize = 2097152} = {}) => {
	const imageBitmap = await createImageBitmap(file);

	try {
		let {width, height} = imageBitmap;
		if (width <= maxSide && height <= maxSide && file.size <= maxSize) return file;

		[width, height] = limitMaxSide(width, height, maxSide);

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');

		ctx.fillStyle = '#FFFFFF';
		ctx.fillRect(0, 0, width, height);

		ctx.drawImage(imageBitmap, 0, 0, width, height);

		for (; ;) {
			let result = await canvas.convertToBlob({
				type: 'image/jpeg',
				quality: quality
			});

			if (result.size <= maxSize || quality <= 0.5) return result;
		}
	} finally {
		imageBitmap.close();
	}
};