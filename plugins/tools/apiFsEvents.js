import {$store, $update, debugSymbol} from "unconscious";
import {EVENT_BUS} from "/src/states.js";
import {updateConversation} from "/src/database.js";
import {createFileSystem} from "./fileAccess.js";
import {sleep} from "/src/utils/pure-utils.js";
import {appendMessages} from "/src/inject-message.js";

const OWNER = debugSymbol("FS__OWNER");
const FS = debugSymbol("FS__FS");
const EVENTS = debugSymbol("FS__EVENTS");

/** @type {import("unconscious").Reactive<Record<string, { [EVENTS]: [], runId: string, since: number }>>} */
const serverStates = $store("eventIds", {}, { persist: true, deep: false });

function registerEvents(conv, mnt, fsEvents) {
	for (let event of fsEvents) {
		event[OWNER] = conv;
		event[FS] = mnt;
	}

	const key = JSON.stringify(mnt.fs_server);
	let state = serverStates[key];
	if (state) {
		if (!state[EVENTS]) {
			state[EVENTS] = [];
			pollLoop(mnt, key, state);
		}

		state[EVENTS].push(...fsEvents.filter(cb => {
			const runId = cb.runId;
			if (runId == null) {
				cb.runId = state.runId;
				return true;
			} else {
				dispatch(cb);
			}
		}));
		return;
	}

	serverStates[key] = state = {[EVENTS]: [...fsEvents],};
	pollLoop(mnt, key, state);
}

/**
 * 从 spawn/shell 的响应文本登记待通知进程
 * @param {string} result 工具响应文本
 * @param {AiChat.Conversation} conv
 * @param {Record<string, string>} par
 */
export const trackProcess = async (result, conv, par) => {
	const m = /^Running in background \(pid=(\d+)/.exec(result);
	if (!m) return;

	let mnt = conv;
	let path = par.cwd;
	if (path?.startsWith("~/")) {
		let end = path.indexOf('/', 2);
		mnt = conv.mnt?.[path.slice(2, end < 0 ? path.length : end)];
	}

	if (mnt.fs_type !== 'db' && mnt.fs_type !== 'api')
		throw new Error("AssertionFailure: mnt.fs_type is "+mnt.fs_type);

	const runId = serverStates[JSON.stringify(mnt)]?.runId;
	const event = {runId, type: 'process-exit', pid: parseInt(m[1])};

	(mnt.fs_events ??= []).push(event);
	registerEvents(conv, mnt, [event]);
	await updateConversation(conv);
};

const pollLoop = async (mnt, key, state) => {
	const call = await createFileSystem(mnt);
	let backoff = 1000;

	const callbacks = state[EVENTS];

	while (true) {
		try {
			const resp = await call('event', state);

			const serverId = resp.runId;
			const clientId = state.runId;

			if (clientId !== serverId) {
				state.runId = serverId;

				const copy = callbacks.filter(cb => {
					const runId = cb.runId;
					if (runId == null || runId === serverId) {
						cb.runId = serverId;
						return true;
					} else {
						dispatch(cb);
					}
				});
				callbacks.length = 0;
				callbacks.push(...copy);
			}

			state.since = resp.next;
			$update(serverStates);

			for (const event of resp.events) {
				const type = event.type;
				if (type === 'process-exit') {
					const idx = callbacks.findIndex(cb => cb.type === type && cb.pid === event.pid);
					if (idx >= 0) {
						const callback = callbacks.splice(idx, 1)[0];
						dispatch(callback, event);
					}
				}
			}

			if (!callbacks.length) {
				delete serverStates[key][EVENTS];
				return;
			}
		} catch (e) {
			console.error("[进程通知] 轮询失败，"+backoff+"ms 后重试", e);
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 60000);
		}
	}
};

const dispatch = (callback, event) => {
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

	updateConversation(conv);

	if (event?.manual) return;

	appendMessages(conv, [{
		role: "user",
		label: "异步进程结束",
		time: Date.now(),
		content: event ? `<system-remainder>
<process-exit pid=${callback.pid} exitCode="${event.code}" logFile="${event.logFile}" />
</system-remainder>` : `<system-remainder>
FileService restarted: PID ${callback.pid} cannot be tracked.
</system-remainder>`
	}]);
};

// 重新拉起轮询
EVENT_BUS.on(['conversation', 'load'], conv => {
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