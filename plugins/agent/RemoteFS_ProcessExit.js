import {debugSymbol} from "unconscious";
import {EditableMessageRoles, EVENT_BUS, MessageRoles} from "/src/states.js";
import "./RemoteFSEvent.css";
import {HighlightBox} from "/src/components/TextDiff.jsx";
import {JsonEditor} from "/src/components/JsonEditor.jsx";

export const PROCESS_EXIT_ROLE = 'process-exit';
const MERGER = debugSymbol("SyntheticMessage");
const prefixOrNone = (s, prefix) => s ? prefix + s : '';

EditableMessageRoles.add(PROCESS_EXIT_ROLE);
MessageRoles[PROCESS_EXIT_ROLE] = {
	name: "进程退出",
	combine: true,
	compose(item, output) {
		const event = item.content;
		let content;

		if (event) {
			content = `<process pid=${item.pid} exitCode="${event.code}" elapsed="${(event.duration/1000).toFixed(1)}s" logFile="${event.logFile}">${prefixOrNone(event.message, '\n')}${prefixOrNone(event.log, '\n\n### Latest log\n\n')}</process>`;
		} else {
			content = `<process pid="${item.pid}">State tracker died. No further notifications.</process>`;
		}

		const last = output.at(-1);
		if (last[MERGER]) last.content += content;
		else output.push({
			role: 'user',
			content,
			[MERGER]: 1
		});
	},
	renderContent(item, chunks, index, isEditing) {
		const event = item.content;
		chunks.push({
			type: "html",
			key: item,
			edit: isEditing(item),
			html: () => {
				if (isEditing(item)) {
					return <JsonEditor value={event} onChange={(str, obj, error) => {
						if (!error) item.content = obj;
					}} />;
				}

				if (!event) {
					return <details className="process-exit-card">
						<summary className="-header">
							<div className="-left">
								<span className="-pid">#{item.pid}</span>
								<span className="ellipsis">State tracker died.</span>
							</div>
							<div className="-right">
								<span className="-code error">???</span>
							</div>
						</summary>
					</details>;
				}

				return <details className="process-exit-card">
					<summary className="-header">
						<div className="-left">
							<span className="-pid">#{item.pid}</span>
							<span className="ellipsis">{event.message || "Finished successfully."}</span>
						</div>
						<div className="-right">
							<span className="-elapsed"><i className="ri-time-line"/>{(event.duration/1000).toFixed(2)}s</span>
							<span className={"-code "+(event.code === '0x0' ? "ok" : "error")}>{event.code}</span>
							<svg className="-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
								 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="6 9 12 15 18 9"></polyline>
							</svg>
						</div>
					</summary>

					<div className="-body">
						<div className="-logs-header">
							<span>最后50行输出</span>
							<button className="ri-file-3-line ghost" onClick={() => {
								EVENT_BUS.post(['viewUrl'], event.logFile);
							}}>打开日志
							</button>
						</div>
						<HighlightBox filename=".log" code={event.log}/>
					</div>
				</details>
			}
		})
	},
	keyFunc(chunk, keys) {
		keys.push(chunk.key.content, chunk.edit);
		return keys;
	}
};
