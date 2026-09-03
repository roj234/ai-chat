import {TimerHeap} from "./TimerHeap.js";

const heap = new TimerHeap();

/**
 * @type {number}
 */
let nextTimer, nextDue;

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
	}, Math.min(Math.max(0, delay), 2147483647));
};

const setTimeout1 = (fn, delay) => schedule(fn, delay, null);
/**
 * 取消指定任务
 * @param {Object} handle
 */
const clearTimeout1 = handle => {
	if (!handle) return;
	if (heap.cancel(handle)) reschedule();
};

export { setTimeout1 as setTimeout, clearTimeout1 as clearTimeout }


/**
 * @param {string} fn
 * @param {number} delay
 * @param {number} period
 * @param {any[]} args
 * @returns {Object}
 */
function schedule(fn, delay, period) {
	const task = { fn, delay, time: Date.now() + delay };
	heap.push(task);
	if (!nextDue || task.time < nextDue) reschedule();
	return task;
}
