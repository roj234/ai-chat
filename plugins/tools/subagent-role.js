import {debugSymbol} from "unconscious";
import {EditableMessageRoles, MessageRoles,} from "/src/states.js";
import "./subagent.css";
import {HighlightBox} from "/src/components/TextDiff.jsx";
import {prettyTime} from "unconscious/common/Utils.js";

export const AGENT_MESSAGE_ROLE = 'agent-message';
const MERGER = debugSymbol("SyntheticMessage");

EditableMessageRoles.add(AGENT_MESSAGE_ROLE);
MessageRoles[AGENT_MESSAGE_ROLE] = {
	name: "代理消息",
	combine: true,
	compose(item, output) {
		let content = `<agent-message from="${item.from}" type="${item.type}">\n\n${item.content}\n\n</agent-message>`;

		const last = output.at(-1);
		if (last[MERGER]) last.content += content;
		else output.push({
			role: 'user',
			content,
			[MERGER]: 1
		});
	},
	renderContent(item, chunks, index, isEditing, messages, defaultRenderContent) {
		if (isEditing(item)) {
			chunks.push({
				type: "text",
				text: item.content,
				key: item,
			})
			return;
		}

		chunks.push({
			type: "html",
			key: item,
			html: () => {
				let pos = item.content.indexOf('\n');
				if (pos < 0) pos = item.content.length;

				return <details className="process-exit-card">
					<summary className="-header">
						<div className="-left">
							<span className="-pid">#{item.from}</span>
							<span className="ellipsis">{item.content.slice(0, Math.min(pos, 120))}</span>
						</div>
						<div className="-right">
							<span className="-elapsed"><i className="ri-time-line"/>{prettyTime(item.time)}</span>
							<span className={"-code "+(item.type === 'error' ? "error" : item.type === 'done' ? "ok" : "")}>{item.type}</span>
							<svg className="-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
								 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="6 9 12 15 18 9"></polyline>
							</svg>
						</div>
					</summary>

					<div className="-body">
						<HighlightBox filename=".md" code={item.content}/>
					</div>
				</details>
			}
		})
	},
	keyFunc(chunk, keys) {
		keys.push(chunk.key.content, chunk.type);
		return keys;
	}
};
