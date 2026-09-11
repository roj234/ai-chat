import {$state, $store, $update, debugSymbol} from "unconscious";
import {EVENT_BUS} from "/src/states.js";
import {updateConversation} from "/src/database.js";
import {createFileSystem} from "./Mounts.js";
import {sleep} from "/common/pure-utils.js";
import {injectMessages} from "/src/inject-message.js";
import {DI, DID_INPUT_BOX_POSITION, onLoad} from "../../src/hooks.js";
import {BackgroundProcessList} from "./BackgroundProcessList.jsx";

const OWNER = debugSymbol("Owner");
const FS = debugSymbol("FileSystem");
const EVENTS = debugSymbol("Events");

const staleCallbacks = new Map;

/** '响应式'更新后台进程 UI */
export const processListVersion = $state(0);
const touchProcessList = () => { processListVersion.value++; };

/** @type {import("unconscious").Reactive<Record<string, { [EVENTS]: [], runId: string, since: number }>>} */
const serverStates = $store("eventIds", {}, { persist: true, deep: false });

const registerEvents = (conv, mnt, fsEvents, isNewListener) => {
	for (let event of fsEvents) {
		event[OWNER] = conv;
		event[FS] = mnt;
	}

	const key = JSON.stringify([mnt.fs_type, mnt.fs_server]);
	let state = serverStates[key];
	if (state) {
		if (!state[EVENTS]) {
			state[EVENTS] = [];
			pollLoop(mnt, key, state);
		}

		if (staleCallbacks.size && isNewListener) {
			const mapKey = key+"#"+fsEvents[0].pid;
			const event = staleCallbacks.get(mapKey);
			if (event) {
				dispatchProcessExit(fsEvents[0], event);
				staleCallbacks.delete(mapKey);
				return;
			}
		}

		state[EVENTS].push(...(isNewListener ? fsEvents : fsEvents.filter(runCallbacks(state.runId))));
		touchProcessList();
		return;
	}

	serverStates[key] = state = {[EVENTS]: [...fsEvents],};
	touchProcessList();
	pollLoop(mnt, key, state);
};

/**
 * 从 spawn/shell 的响应文本登记待通知进程
 * @param {string} result 工具响应文本
 * @param {AiChat.Conversation} conv
 * @param {Record<string, string>} par
 */
export const trackProcess = async (result, conv, par) => {
	const m = /^(?:TIMEOUT, )?Running in background \(pid=(\d+)/.exec(result);
	if (!m) return;

	let mnt = conv;
	let path = par.cwd;
	if (path?.startsWith("~/")) {
		let end = path.indexOf('/', 2);
		const mountId = path.slice(2, end < 0 ? path.length : end);
		mnt = conv.mnt?.[mountId];

		path = '~/'+mountId;
	} else {
		path = '';
	}

	if (mnt.fs_type !== 'db' && mnt.fs_type !== 'api')
		throw new Error("AssertionFailure: mnt.fs_type is "+mnt.fs_type);

	const explanation = (par.explanation || (par.program ? [par.program, ...(par.arguments || [])].join(' ') : par.command)).slice(0, 100);

	const event = {
		type: 'process-exit',
		pid: parseInt(m[1]),
		explanation,
		cwd: path,
		start: Date.now(),
	};

	(mnt.fs_events ??= []).push(event);
	registerEvents(conv, mnt, [event], true);
	await updateConversation(conv);
};

const runCallbacks = serverId => cb => {
	const runId = cb.runId;
	if (runId == null || runId === serverId) {
		cb.runId = serverId;
		return true;
	} else {
		dispatchProcessExit(cb);
	}
};

const pollLoop = async (mnt, key, state) => {
	const call = await createFileSystem(mnt);
	let backoff = 1000;

	const callbacks = state[EVENTS];

	state.since ??= 0;
	while (true) {
		try {
			const resp = await call('event', state);

			const serverId = resp.runId;
			const clientId = state.runId;

			if (clientId !== serverId) {
				state.runId = serverId;
				state.since = 0;

				const copy = callbacks.filter(runCallbacks(serverId));
				callbacks.length = 0;
				callbacks.push(...copy);
			} else {
				state.since = resp.next;
			}

			$update(serverStates);

			for (const event of resp.events) {
				const type = event.type;
				if (type === 'process-exit') {
					let idx = callbacks.findIndex(cb => cb.type === type && cb.pid === event.pid);
					if (idx < 0) staleCallbacks.set(key+'#'+event.pid, event);
					else {
						const callback = callbacks.splice(idx, 1)[0];
						dispatchProcessExit(callback, event);
					}
				}
			}

			if (!callbacks.length) {
				delete serverStates[key];
				return;
			}
		} catch (e) {
			console.error("[进程通知] 轮询失败，"+backoff+"ms 后重试", e);
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 60000);
		}
	}
};

export const dispatchProcessExit = (callback, event) => {
	/** @type {AiChat.Conversation} */
	const conv = callback[OWNER];
	/** @type {AiChat.Mount} */
	const mnt = callback[FS];

	const events = mnt.fs_events;
	let i = events.indexOf(callback);
	if (i >= 0) {
		events.splice(i, 1);
		if (!events.length) delete mnt.fs_events;
	}

	touchProcessList();
	updateConversation(conv);

	const desc = event?.message;
	if (desc === true) return;

	injectMessages(conv, {
		role: "user",
		label: "异步进程结束",
		time: Date.now(),
		content: event
			? `<process pid=${callback.pid} exitCode="${event.code}" logFile="${event.logFile}">${desc || 'exited'}</process>`
			: `<system-remainder>PID ${callback.pid} state tracker was stopped.</system-remainder>`
	});
};

// 重新拉起轮询
EVENT_BUS.on('convLoad', conv => {
	const fsEvents = conv.fs_events;
	if (fsEvents) registerEvents(conv, conv, fsEvents);
	const mnt = conv.mnt;
	if (mnt) {
		for (const fs of Object.values(mnt)) {
			const fsEvents = fs.fs_events;
			if (fsEvents) registerEvents(conv, fs, fsEvents);
		}
	}
});

onLoad(() => {
	const el = DI[DID_INPUT_BOX_POSITION];
	el.parentElement.insertBefore(<BackgroundProcessList />, el.nextElementSibling);
})