import {callFileSystemFunc, createFileSystem} from "../agent/index.js";
import {selectedConversation} from "../../src/states.js";
import {openWindow} from "../../src/components/Windows.jsx";
import {$state, $vforeach, unconscious} from "unconscious";
import {ansiToHtml} from "@roj234/ansi2html";

import "./Terminal.css";
import {prettyError} from "../../src/utils/utils.js";
import {sseFetch} from "../../common/fetch-utils.js";
import {normalizePath} from "@roj234/shared/path";
import {ref} from "@roj234/shared";

const iconTerminal = () => <div className="icon ri-terminal-fill" />;

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} [cwd]
 */
export const openTerminal = async (fs, cwd = '') => {
	fs ??= await createFileSystem(unconscious(selectedConversation));
	const id = crypto.randomUUID();

	const lines = $state([{s:'前台终端：网断了/关窗口=杀进程树，无法后台运序'}]);
	const disabled = $state(true);
	const clearOutput = () => lines.value = [{s:`输出已清除 (${new Date().toLocaleString()})`}];

	const terminal = openWindow({
		id: "terminal "+id,
		title: "终端 (前台)",
		icon: iconTerminal(),
		width: 800,
		height: 600,
		element: () => {
			const HISTORY_LIMIT = 200;
			const commandHistory = [];
			let historyIndex = -1;
			let inputEl = ref();
			let outEl = ref();

			const onInputKeydown = e => {
				if (e.isComposing) return;

				if (e.key === 'ArrowUp') {
					e.preventDefault();
					if (commandHistory.length > 0) {
						if (historyIndex < 0) historyIndex = commandHistory.length;
						if (historyIndex > 0) historyIndex--;
						inputEl.value = commandHistory[historyIndex] || '';
					}
				} else if (e.key === 'ArrowDown') {
					e.preventDefault();
					if (historyIndex >= 0 && historyIndex < commandHistory.length - 1) {
						historyIndex++;
						inputEl.value = commandHistory[historyIndex] || '';
					} else {
						historyIndex = -1;
						inputEl.value = '';
					}
				} else if (e.key === 'Enter') {
					if (!e.shiftKey) {
						e.preventDefault();
						const command = inputEl.value.trim();
						if (command) sendCommand(command);
					}
				} else if (e.key === 'l' && e.ctrlKey) {
					e.preventDefault();
					clearOutput();
				}
			};

			const sendCommand = command => {
				if (command.trim()) {
					const hist = commandHistory;
					if (hist.length >= HISTORY_LIMIT) hist.shift();
					const prevIndex = hist.indexOf(command);
					if (prevIndex >= 0) hist.splice(prevIndex, 1);
					hist.push(command);
					historyIndex = -1;

					callFileSystemFunc(fs, 'terminalWrite', {id, content: command+'\n'});
					lastLine.replaceChildren();
				}
				inputEl.value = '';
			};

			let isAtBottom;
			const io = new IntersectionObserver((entries) => {
				isAtBottom = entries.some(s => s.isIntersecting);
				if (isAtBottom) newLine.style.display = 'none';
			});
			const lastLine = <div className="line"/>;
			const newLine = <div className="new" style="display:none" onClick={() => {
				outEl.scrollTop = 1e9;
			}}>新消息</div>;

			io.observe(lastLine);

			callFileSystemFunc(fs, 'getUrl').then(({base, root = '', headers}) => sseFetch(base+'terminal', {
				key: headers.authorization.slice('Bearer '.length),
				json: false,
				body: JSON.stringify({
					id,
					cwd: normalizePath(root+'/'+cwd).join('/') || '.',
				})
			}, chunk => {
				const type = chunk[0];
				if (type === 'L') lastLine.innerHTML = ansiToHtml(chunk.slice(1));
				else lines.push({s:chunk.slice(1),t: type === 'E' ? 'stderr' : 'stdout'});
				if (!isAtBottom) newLine.style.display = '';
				else queueMicrotask(() => outEl.scrollTop = 1e9);
				disabled.value = false;
			})).catch(err => {
				const str = "终端异常断开\n"+prettyError(err);
				lines.push(...str.split('\n').map(s => ({s})));
			}).finally(() => {
				lines.push({s:"终端已经结束，您可以关闭此窗口"});
				disabled.value = true;
				lastLine.remove();
				newLine.remove();
			});

			return <>
				<div ref={outEl} className="out">
					{$vforeach(lines, line => <div className="line" dangerouslySetInnerHTML={ansiToHtml(line.s)}></div>)}
					{lastLine}
					{newLine}
				</div>
				<div className="in">
					<span className="icon">&gt;</span>
					<textarea className="input" autoComplete="off" spellCheck="false"
						placeholder="输入命令，Enter发送，Shift+Enter换行..."
						ref={inputEl}
						disabled={disabled} onKeyDown={onInputKeydown} />
				</div>
			</>
		},
		actions: <>
			<button className="btn ghost" onClick={clearOutput}>清屏</button>
		</>
	});
	return terminal;
}
