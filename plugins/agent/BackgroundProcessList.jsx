import {$computed, $foreach, unconscious} from "unconscious";
import {selectedConversation} from "/src/states.js";
import {showToast} from "/src/components/Toast.js";
import {prettyError} from "/src/utils/utils.js";
import {dispatchProcessExit, processListVersion} from "./RemoteFSEvent.js";
import "./BackgroundProcessList.css";
import {fileAccess} from "./Mounts.js";

/** 已经点了中止、等待服务端推送 process-exit 的事件 */
const stopping = new WeakSet();

/**
 * 收集当前会话（含挂载点）里仍在运行的后台进程
 * @param {AiChat.Conversation} conv
 */
const collectProcesses = conv => {
	const result = [];
	const push = events => {
		if (!events) return;
		for (const event of events) {
			if (event.type === 'process-exit') result.push(event);
		}
	};

	push(conv.fs_events);
	const mnt = conv.mnt;
	if (mnt) {
		for (const key in mnt) push(mnt[key].fs_events);
	}
	return result.sort((a, b) => (a.start || 0) - (b.start || 0));
};


const killProcess = fileAccess("kill");

/**
 * 后台进程操作条
 * @return {JSX.Element}
 */
export function BackgroundProcessList() {
	const items = $computed(() => {
		unconscious(processListVersion);
		const conv = unconscious(selectedConversation);
		return conv ? collectProcesses(conv) : [];
	});

	return (
		<div className="pending-msgs bg-procs" style:display={() => items.length ? "" : "none"} aria-label="后台进程">
			<div role="list">{$foreach(items, proc => {
				const pid = proc.pid;
				const explanation = proc.explanation || "后台进程";
				const pending = stopping.has(proc);

				return (
					<div role="listitem"
						 title={`${explanation}\nPID ${pid}${proc.cwd ? "\nVFS " + proc.cwd : ""}`}>
						<i className="spinner" aria-hidden />
						<span className="text ellipsis">{explanation}</span>
						<span className="bp-pid">PID {pid}</span>
						<button className="btn bp-kill" disabled={pending}
								onClick={({target}) => {
									target.disabled = true;
									target.textContent = "请稍候";
									stopping.add(proc);

									killProcess({pid: proc.pid, cwd: proc.cwd, message: 'terminated by user' }, {}, unconscious(selectedConversation)).then(result => {
										if (result.startsWith("status: exited earlier") || result.startsWith("Error:")) {
											dispatchProcessExit(proc);
										}
									}, e => {
										target.disabled = false;
										target.textContent = "中止";
										showToast(prettyError(e), 'error');
									});
						}}>
							{pending ? "中止中…" : "中止"}
						</button>
					</div>
				);
			})}</div>
		</div>
	);
}
