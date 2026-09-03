import {kvListDel, kvListGetValues, kvListSet} from './database.js';
import {onLoad} from "./hooks.js";
import {TimerHeap} from "../common/TimerHeap.js";

const heap = new TimerHeap();

const TASK_TYPE = 'timer';
const callbacks = new Map();

/**
 * @type {number}
 */
let nextTimer, nextDue;

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

	const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
	const task = { callback, args, time: Date.now() + delay };

	await kvListSet(task, TASK_TYPE, name);
	task.id = name;
	heap.push(task);

	if (!nextDue || task.time < nextDue) reschedule();
	return name;
}

/**
 * 取消指定任务
 * @param {string} name
 */
export async function cancel(name) {
	await kvListDel(TASK_TYPE, name);

	const resched = heap.cancel(name);

	const size = heap.cancelled.size;
	if (size > 32 && size > heap.length / 2) {
		clearTimeout(nextTimer);
		await reload();
	} else if (resched) {
		reschedule();
	}
}

const reload = async () => {
	heap.length = 0;
	heap.cancelled.clear();

	const tasks = await kvListGetValues(TASK_TYPE);
	const now = Date.now();
	const due = [];
	for (const task of tasks) {
		if (task.time <= now) {
			due.push(task);
		} else {
			heap.push(task);
			task.id = task.name;
		}
	}

	if (heap.length) {
		heap.init();
		reschedule();
	}

	await Promise.all(due.map(execute))
}

onLoad(reload);