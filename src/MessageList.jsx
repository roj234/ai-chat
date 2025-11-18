import {ThinkBlock} from "./ThinkBlock.jsx";
import {ToolCallCard} from "./ToolCallCard.jsx";
import {$foreach, debugSymbol} from "unconscious";
import {formatDate} from "unconscious/ext/Utils.js";
import {markdown} from "./markdown-stream.js";
import {config, messages} from "./states.js";
import {AS_IS} from "unconscious@shared";
import {ChartCreator} from "./Chart.js";
import {abortCompletion, sendMessage} from "./api-request.js";
import markdownIt from "markdown-it";
import {loadMermaid} from "./async-loader.js";
import {getTextContent} from "./utils.js";

/**
 *
 * @param {AiChat.Message[]} messages
 * @return {string}
 */
export function messagesToText(messages) {
	const lines = [];
	for (const m of messages) {
		let header = `[${m.role}]`;

		// 构建 metadata JSON（只包含非 role/content 的属性）
		const metadata = {};
		if (m.time) metadata.time = m.time;
		if (m.model) metadata.model = m.model;
		if (m.think) metadata.think = m.think;
		if (m.tool_calls) metadata.tool_calls = m.tool_calls;
		if (m.tool_call_id) metadata.tool_call_id = m.tool_call_id;

		if (Object.keys(metadata).length) {
			header += " "+JSON.stringify(metadata);
		}

		lines.push(header+'\n'+m.content+'\n');
	}
	return lines.join('\n').trim();
}

/**
 *
 * @param {string} text
 * @return {AiChat.Message[]}
 */
export function textToMessages(text) {
	const out = [];
	if (!text) return out;

	let cur = null;

	const pushCur = () => {
		if (cur && (cur.content = cur.content.trim() || cur.tool_calls)) {
			out.push(cur);
		}
		cur = null;
	};

	for (const line of text.split('\n')) {
		// role, metadata
		const roleMatch = line.match(/^\[(system|user|assistant|tool)]\s?(\{.*})?/i);
		if (roleMatch) {
			pushCur();

			cur = roleMatch[2] ? JSON.parse(roleMatch[2]) : {};
			cur.role = roleMatch[1].toLowerCase();
			cur.content = "";
		} else {
			cur.content += line + '\n';
		}
	}

	pushCur();

	// 处理 systemPrompt
	const sp = config.systemPrompt?.trim();
	if (sp && out[0]?.role === 'system' && out[0].content === sp) {
		out.shift();
	}

	return out;
}

/**
 *
 * @param {AiChat.Message} m
 * @return {string}
 */
function roleName(m) {
	if (m.role === "user") return "你";
	if (m.role === "assistant") return m.model || "大语言模型";
	if (m.role === "tool") return "函数调用";
	return m.role;
}

/**
 *
 * @type {Map<AiChat.Message, JSX.Element>}
 */
export const renderedMessages = new Map();

const markdownForCopy = /*#__PURE__*/ markdownIt();

const ID_SYM = debugSymbol("renderId");
let renderCounter = 0;

/**
 * @param {AiChat.Message} m
 * @param {number} i
 * @return {string}
 */
const keyFunc = (m, i) => {
	let id = m[ID_SYM];
	if (!id) {
		id = ++renderCounter;
		m[ID_SYM] = id;
	}
	return id+"_"+(m.tool_call_id||m.finish_reason||m.role)+"_"+(m.role === "assistant" && i === messages.length-1 && abortCompletion == null);
};
/**
 *
 * @param {AiChat.Message} m
 * @param {number} i
 * @return {JSX.Element}
 */
const listItemRenderer = (m, i) => {
	let text = '';
	let images = [];

	if (Array.isArray(m.content)) {
		for(const item of m.content) {
			if (item.type === "text") {
				text += item.text;
			} else if (item.type === "image_url") {
				images.push(<img src={item.image_url.url} />);
			}
		}
	} else if (m.content) {
		text = m.content;
	}

	const content = <div className="content" dangerouslySetInnerHTML={markdown.render(text)}/>;
	requestIdleCallback(() => {
		if (!content.isConnected) return;

		for (const el of content.querySelectorAll("div.chart-loading")) {
			// 确保隔壁工具的更新能赶上（
			const chart = ChartCreator.getChart(el.dataset.id);
			if (chart) {
				el.replaceWith(chart.canvas);
				chart.resize();
			} else {
				el.replaceWith(<div className="error-block">
					<pre className="error-text">图表 {el.dataset.id} 不存在</pre>
				</div>);
			}
		}
	});

	const mermaidNodes = content.querySelectorAll('.language-mermaid .hljs');
	if (mermaidNodes.length) {
		loadMermaid().then(mermaid => {
			mermaid.run({ nodes: mermaidNodes });
		})
	}

	return <article className={`msg ${m.role}`} data-id={i} role="article" aria-label={`${m.role} message`}>
		<div className="role-line sticky">
			<span className={`my-badge role-${m.role}`}>{roleName(m)}</span>
			{AS_IS(m.tool_call_id) ? <span className="my-badge role-assistant">{m.tool_call_id}</span> : null}
			<span className="time">{formatDate('Y-m-d H:i:s', m.time)}</span>
			{AS_IS(m.usage) ? <span className="my-chip">{m.usage}</span> : null}
			<span className='spacer'></span>
			<span className='buttons'>
				{AS_IS(m.role === "assistant" && m.finish_reason && i === messages.length - 1 && abortCompletion == null)
					? <button data-action="regen" title="重新生成" className="i dice"></button> : null}
				{AS_IS(i !== messages.length - 1 || abortCompletion == null) ? <button data-action="del" title="删除消息" className="i delete"></button> : null}
				{AS_IS(m.role !== "assistant" || m.finish_reason && !m.error) ? <button data-action="copy" title="复制消息"  className="i copy"></button> : null}
			</span>
		</div>
		<section className="body">
			<ThinkBlock think={m.think}/>
			{content}
			{AS_IS(images.length) ? <div className="gallery">{images}</div> : null}

			{m.tool_calls?.length && (
				<div className="tool-calls" role="group" aria-label="Tool calls">
					{m.tool_calls.map((tool, idx) => (
						<ToolCallCard key={tool.id || `tc-${idx}`} tool={tool}/>
					))}
				</div>
			) || null}

			{AS_IS(m.error) ? (
				<div className="error-block">
					<pre className="error-text">{m.error}</pre>
				</div>
			) : null}
		</section>
	</article>;
};

export const copyMessageHandler = (e) => {
	const btn = e.target.closest(".role-line button[data-action]");
	if (!btn) return;

	let article = e.target.closest(".msg");

	switch (btn.dataset.action) {
		case "copy": {
			const m = getTextContent(messages[article.dataset.id]);
			navigator.clipboard.write([new ClipboardItem({
				'text/html': new Blob([markdownForCopy.render(m)], { type: 'text/html' }),
				'text/plain': new Blob([m], { type: 'text/plain' })
			})]);
			btn.className = "i checked";
			setTimeout(() => btn.className = "i copy", 1000);
		}
		break;
		case "regen": {
			messages.pop();
			sendMessage("");
		}
		break;
		case "del": {
			messages.splice(article.dataset.id, 1);
			while (true) {
				article = article.nextElementSibling;
				if (!article) break;
				article.dataset.id--;
				console.log(article);
			}
		}
		break;
	}
};

/**
 *
 * @param {AiChat.Message} message
 */
export function forceRenderMessage(message) {
	const key = keyFunc(message, messages.length-1);
	const oldNode = renderedMessages.get(key);

	const node = listItemRenderer(message, messages.length-1);
	renderedMessages.set(key, node);
	oldNode?.replaceWith(node);
}

// TODO use VirtualList
export function MessageList(/*{messages}*/) {
	return $foreach(messages, listItemRenderer, keyFunc, renderedMessages);
}