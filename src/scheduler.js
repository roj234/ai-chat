import {kvListDel, kvListGetValues, kvListSet} from './database.js';
import {onLoad} from "./hooks.js";

// ==================== 最小堆 ====================

let heap = [];
const cancelled = new Set();

const heapPush = task => {
	heap.push(task);
	siftUp(heap.length - 1);
};

const heapPeek = () => {
	while (heap.length && cancelled.has(heap[0].name)) {
		cancelled.delete(heap[0].name);
		removeTop();
	}
	return heap[0];
};

const removeTop = () => {
	if (heap.length <= 1) { heap.length = 0; return; }
	heap[0] = heap.pop();
	siftDown(0);
};

const siftUp = i => {
	const node = heap[i];
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (heap[p].dueTime <= node.dueTime) break;
		heap[i] = heap[p];
		i = p;
	}
	heap[i] = node;
};

const siftDown = i => {
	const node = heap[i];
	const size = heap.length;
	const half = size >> 1;
	while (i < half) {
		let child = (i << 1) + 1;
		let right = child + 1;
		if (right < size && heap[right].dueTime < heap[child].dueTime) child = right;
		if (node.dueTime <= heap[child].dueTime) break;
		heap[i] = heap[child];
		i = child;
	}
	heap[i] = node;
};

/** O(n) Floyd 建堆 */
const heapify = () => {
	for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(i);
};

const TASK_TYPE = 'timer';
const callbacks = new Map();

/**
 * @type {number}
 */
let nextTimer, nextDue;

// ==================== 驱动循环 ====================

const reschedule = () => {
	clearTimeout(nextTimer);

	nextDue = heapPeek()?.dueTime;
	if (!nextDue) return;

	const delay = nextDue - Date.now();

	nextTimer = setTimeout(() => {
		const now = Date.now();

		while (true) {
			const t = heapPeek();
			if (!t || t.dueTime > now) break;
			removeTop();
			execute(t);
		}

		reschedule();
	}, Math.max(0, delay));
};

async function execute(task) {
	const fn = callbacks.get(task.callback);
	if (fn) {
		try { await fn(...task.args); }
		catch (e) { console.error(`[Scheduler] ${task.callback} 执行失败:`, e); }
	}
	await kvListDel(TASK_TYPE, task.name);
}

// ==================== 公开 API ====================

/**
 * 注册回调，需要在onload之前注册
 * @param {string} name
 * @param {Function} fn
 */
export const registerScheduler = (name, fn) => callbacks.set(name, fn);

/**
 * 调度一个任务在 delay 毫秒后执行
 * @param {string} callback
 * @param {number} delay
 * @param {any[]} args
 * @returns {Promise<string>} taskId
 */
export async function schedule(callback, delay, ...args) {
	if (!callbacks.has(callback)) throw new Error(`[TaskScheduler] 未注册的回调: '${callback}'`);

	const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
	const task = { callback, args, dueTime: Date.now() + delay };

	await kvListSet(task, TASK_TYPE, name);
	heapPush(task);

	if (!nextDue || task.dueTime < nextDue) reschedule();
	return name;
}

/**
 * 取消指定任务
 * @param {string} taskId
 */
export async function cancel(taskId) {
	const top = heapPeek();

	cancelled.add(taskId);
	await kvListDel(TASK_TYPE, taskId);

	if (top?.name === taskId) {
		removeTop();
		reschedule();
	}

	const size = cancelled.size;
	if (size > 32 && size > heap.length / 2) {
		clearTimeout(nextTimer);
		await reload();
	}
}

const reload = async () => {
	heap.length = 0;
	cancelled.clear();

	const tasks = await kvListGetValues(TASK_TYPE);
	const now = Date.now();
	const due = [];
	for (const task of tasks) {
		if (task.dueTime <= now) {
			due.push(task);
		} else {
			heap.push(task);
		}
	}

	if (heap.length) {
		heapify();
		reschedule();
	}

	await Promise.all(due.map(execute))
}

onLoad(reload);