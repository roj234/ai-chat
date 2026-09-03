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

export const PROMISE_CATCH = () => {};

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @template T
 * @param {T} input
 * @return {Readonly<T>}
 */
export const fastObjectMap = input => Object.freeze(Object.assign(Object.create(null), input));

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
 * @param {Object} obj
 * @param {string|symbol} prop
 * @param {(ret: any, ...args: any[]) => any} callback
 * @returns {Function}
 */
export function hook(obj, prop, callback) {
	const original = obj[prop];
	if (typeof original !== "function") throw new TypeError(`hook: obj.${String(prop)} 不是一个函数`);

	obj[prop] = function (...args) {
		const ret = original.apply(this, args);
		const modified = callback.call(this, ret, ...args);
		return modified === undefined ? ret : modified;
	};

	// 方便恢复
	obj[prop].__original = original;
	return original;
}

/**
 * 根据字符串和其中的索引计算所在行 / 列，并返回带定位箭头的多行字符串。
 * @param {string} string
 * @param {number} index
 * @returns {string}
 */
export function locate(string, index) {
	if (!Number.isSafeInteger(index) || index < 0) throw new TypeError("locate: index 必须是非负整数");

	// 1. 计算 line / lineStart / column
	let line = 1;
	let lineStart = 0;
	const limit = Math.min(index, string.length);
	for (let i = 0; i < limit; i++) {
		if (string.charCodeAt(i) === 10 /* \n */) {
			line++;
			lineStart = i + 1;
		}
	}
	const column = index - lineStart;

	// 2. 取出当前行内容
	let lineEnd = lineStart;
	while (lineEnd < string.length && string.charCodeAt(lineEnd) !== 10) {
		lineEnd++;
	}
	const lineContent = string.substring(lineStart, lineEnd);

	// 3. 终端显示宽度（CJK / 全角符号占 2 列）
	const wideRe =
		/[\u1100-\u115F\u2329-\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
	const getStringWidth = (s) => {
		let w = 0;
		for (const ch of s) w += wideRe.test(ch) ? 2 : 1;
		return w;
	};
	const digitCount = (n) => String(n).length;

	let k = `第${line}行: `;
	if (column < 0 || column > lineContent.length || lineContent.length > 220) {
		k += `列: ${column}`;
	} else {
		k += lineContent + "\n";
		const off = 6 + digitCount(line) + getStringWidth(lineContent.substring(0, column));
		k += "-".repeat(off) + "^";
	}
	k += `\n总偏移: ${index}`;
	return k;
}