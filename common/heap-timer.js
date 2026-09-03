import {TimerHeap} from "./TimerHeap.js";

const heap = new TimerHeap();

/**
 * @type {number}
 */
let nextTimer, nextDue, nextId = 1;

// ==================== 驱动循环 ====================

const reschedule = () => {
	clearTimeout(nextTimer);

	nextDue = heap.peek()?.time;
	if (!nextDue) return;

	const delay = nextDue - Date.now();

	nextTimer = setTimeout(() => {
		const now = Date.now();

		while (true) {
			const t = heap.peek();
			if (!t || t.time > now) break;
			heap.shift();
			queueMicrotask(t.fn);
		}

		reschedule();
	}, Math.max(0, delay));
};

export const setTimeout = (fn, delay) => schedule(fn, delay, null);
export const setInterval = (fn, period) => {
	if (!(period > 0)) throw new Error('period must be > 0');
	return schedule(fn, period, period);
};
/**
 * 取消指定任务
 * @param {number} id
 */
export const clearTimeout = id => {
	if (!id) return;
	if (heap.cancel(id)) reschedule();
};
export const clearInterval = clearTimeout;

/**
 * @param {string} fn
 * @param {number} delay
 * @param {number} period
 * @param {any[]} args
 * @returns {number}
 */
function schedule(fn, delay, period) {
	const id = nextId++;
	const task = { id, fn, period, time: Date.now() + delay };

	heap.push(task);

	if (!nextDue || task.time < nextDue) reschedule();
	return id;
}
