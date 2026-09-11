import {ONCE_EVENT} from "unconscious/shared.js";

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
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @return {Promise<T>}
 */
export const abortable = (promise, signal) => {
	if (signal.aborted) return Promise.reject(signal.reason);

	return new Promise((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener('abort', onAbort, ONCE_EVENT);
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		promise.then(resolve, reject).finally(cleanup);
	});
};

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