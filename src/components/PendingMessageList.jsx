import {$foreach, $update, unconscious} from "unconscious";
import {EVENT_BUS, inputText, selectedConversation} from "../states.js";
import {updateConversation} from "../database.js";

import "./PendingMessageList.css";

const isBlob = v => v instanceof Blob;

/**
 * 把 content 拆成 单行文本 / 首个图片 / 附件计数
 * @param {string | OpenAI.ContentPart[]} content
 */
function summarize(content) {
	let text = "";
	let fileCount = 0;

	const push = part => {
		if (typeof part === "string") {
			text += part;
			return;
		}
		switch (part?.type) {
			case "text": {
				const t = part.text;
				if (isBlob(t)) {
					fileCount++;
					text += ` [${t.name || "文件"}] `;
				} else if (t != null) text += t;
				break;
			}
			default:
				fileCount++;
		}
	};

	if (Array.isArray(content)) content.forEach(push);
	else if (content != null) push(content);

	return {text: text.replace(/\s+/g, " ").trim(), fileCount};
}

/**
 * @param {object} [props]
 * @param {import("unconscious").Reactive<AiChat.Message[]>} [props.items] 默认 selectedConversation
 * @param {import("unconscious").Reactive<OpenAI.ContentPart[]>} [props.attachments] composer 的附件数组
 * @param {HTMLTextAreaElement} [props.input] 用于撤回后自动撑高输入框
 * @return {JSX.Element}
 */
export function PendingMessageList({attachments, items, input} = {}) {
	EVENT_BUS.on(["messageInject"], () => {
		$update(unconscious(items) === selectedConversation.pendingMessages ? items : selectedConversation);
	});

	/**
	 * 撤回一条：从队列里摘掉 + 内容放回输入框
	 * @param {AiChat.Message} message
	 */
	const recall = async (message) => {
		const index = items.indexOf(message);
		if (index < 0) return;

		items.splice(index, 1);
		//if (!items.length) delete conversation.pendingMessages;

		let restored = [];
		let content = message.content;
		if (typeof content === 'string') {
			restored = [content];
		} else {
			for (const part of content) {
				if (part.type !== "text" && isBlob(part.text)) {
					attachments.push(part);
				} else {
					// FIXME 用哈希标识符插进去的文件怎么解决
					restored.push(part.text);
				}
			}
		}

		restored = restored.join('\n');

		const prev = inputText.value || "";
		inputText.value = prev && !prev.endsWith("\n") ? `${prev}\n${restored}` : prev + restored;

		if (input) requestAnimationFrame(() => {
			input.style.height = "";
			input.style.height = input.scrollHeight + "px";
			input.focus?.();
		});

		$update(items);
		await updateConversation(unconscious(selectedConversation));
	};


	return (
		<div className="pending-msgs" style:display={() => items.length ? "" : "none"} aria-label="待发送消息">
			<div className="pm-list" role="list">{$foreach(items, (message) => {
				const {text, fileCount} = summarize(message.content);

				const preview = text || `${fileCount} 个文件`;

				return (
					<div className="pm-item" role="listitem" title={preview}>
						{fileCount ? <i className="ri-file-line pm-file"/> : null}
						{message.label && <span className="pm-role">{message.label}</span>}
						<span className="pm-text ellipsis">{preview}</span>
						<button className="pm-recall" title="撤回并放回输入框" tabIndex={0}
								onClick={() => recall(message)}>
							<i className="ri-corner-up-left-line"/>
						</button>
					</div>
				);
			})}</div>
		</div>
	);
}
