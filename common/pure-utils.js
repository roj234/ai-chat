import {ONCE_EVENT} from "unconscious/shared.js";

/**
 * MPSC（多生产者-单消费者）调度器：为异步遍历（如 glob）提供背压与任务移交。
 *
 * @param {number} lowWater 水位下限：队列长度低于该值时开始移交待执行任务
 * @param {number} highWater 水位上限：队列积压达到该值后 push() 开始背压
 */
export function mpscScheduler(lowWater, highWater) {
	const tasks = [];
	let queue = [];
	let head = 0, tail = 0;

	let notifyConsumer;
	let running = 0, lowThres = 0;
	let error;

	const doSubmit = (fn) => {
		running++;
		fn().catch(e => {
			if (!error) error = e;
		}).finally(() => {
			if (--running <= lowThres) {
				notifyConsumer?.();
				lowThres = 0;
			}
		});
	}

	function push(item) {
		if (error) throw error;

		const size = tail - head;
		queue[tail++] = item;

		if (size >= highWater) {
			return new Promise((r, c) => tasks.push([r, c]));
		}

		if (!size) notifyConsumer?.();
	}

	function submit(cb) {
		if (error) throw error;

		// 启发式限制，几乎可以消除等待 push() 的必要
		if (tail - head + tasks.length + running >= highWater) {
			const p = new Promise((r, c) => tasks.push([r, c, cb, doSubmit]));
			notifyConsumer?.();
			return p;
		}

		doSubmit(cb);
	}

	async function* drain() {
		try {
			let threshold;
			while (true) {
				for(;;) {
					if (error) throw error;

					threshold = running;

					let queueSize = tail - head;
					if (queueSize <= lowWater) {
						const task = tasks.shift();
						if (task) {
							task[0]();

							const data = task[2];
							if (data) task[3](data);
						}
					}

					const item = queue[head];
					if (item == null) break;

					queue[head++] = undefined;

					if (head === tail) { head = tail = 0; }
					else if (head > highWater) { queue = queue.slice(head); tail -= head; head = 0; }

					yield item;
				}

				if (!running && !tasks.length) break;

				lowThres = threshold;
				await new Promise(r => notifyConsumer = r);
			}
		} catch (e) {
			if (!error) error = e;
			throw e;
		} finally {
			if (!error) error = new DOMException("Aborted", "AbortError");
			tasks.forEach(c => c[1](error));
		}
	}

	return { push, submit, drain };
}

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

/**
 * Promise节流函数
 * @template {Function} T
 * @param {T} fn
 * @return {T}
 */
export const throttledPromiseLast = (fn) => {
	let inP, outP, rr, re;
	let latestArgs;

	const invoke = (argArray) => {
		inP = fn(...argArray).finally(() => {
			if (latestArgs) {
				const n = latestArgs;
				latestArgs = null;
				return invoke(n);
			} else {
				inP.then(rr, re);
				rr = re = inP = outP = null;
			}
		})
	};

	return (...args) => {
		if (!outP) {
			outP = new Promise((resolve, reject) => { rr = resolve; re = reject; });
			invoke(args);
		}
		else latestArgs = args;

		return outP;
	};
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