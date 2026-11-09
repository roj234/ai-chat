/**
 * 行渲染：分词，选区，HTML 片段
 * - 依赖修改的vendored的HLJS Core注入的特殊配置项
 */

import hljs from "/vendor/hljs/core.js";
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";

/** 超长行（比如压缩后的 JSON）只渲染前 N 个字符，避免一次性把几 MB 文本塞进一个 DOM 节点 */
const MAX_RENDER_CHARS = 10000;

/**
 * @param {HTMLSpanElement} node
 * @param {string} text 行文本
 * @param {?number[]} tokens 分词结果；null 表示还没算出来，按纯文本渲染
 * @param {number} selFrom 选区起点（-1 表示无选区）
 * @param {number} selTo 选区终点
 * @return {void}
 */
export const lineDOM = (node, text, tokens, selFrom, selTo) => {
	if (text.length > MAX_RENDER_CHARS) {
		return node.replaceChildren(text.slice(0, MAX_RENDER_CHARS), <span className="vje-trunc">… 这一行共有 {text.length.toLocaleString("en-US")} 个字符，已折叠显示</span>);
	}

	node.replaceChildren();

	const hasSel = selFrom >= 0 && selTo > selFrom;

	if (!tokens?.length) tokens = [text.length, ''];

	let start = 0;
	for (let i = 0; i < tokens.length; i += 2) {
		const end = tokens[i];
		const cls = tokens[i + 1];

		if (!hasSel || selTo <= start || selFrom >= end) {
			node.append(cls ? <span className={cls}>{text.slice(start, end)}</span> : text.slice(start, end));
		} else {
			const a = Math.max(start, selFrom);
			const b = Math.min(end, selTo);

			const array = [];

			if (a > start) array.push(text.slice(start, a));
			array.push(<span className="sel">{text.slice(a, b)}</span>);
			if (b < end) array.push(text.slice(b, end))

			if (cls) node.append(<span className={cls}>{array}</span>);
			else node.append(...array);
		}

		start = end;
	}
};

/* ------------------------------------------------------------------ *
 * 语言与高亮任务
 * ------------------------------------------------------------------ */

/** 单次高亮的窗口上限，超了就退回纯文本，避免一次解析几十 MB */
const MAX_WINDOW_CHARS = 400000;
/** 每个宏任务里最多连续跑多少毫秒。 */
const SLICE_MS = 5;

/**
 * 异步高亮 [from, to) 这段行。
 *
 * @param {{text: string}[]} lines 文档的行数组（直接读 text，不复制整篇）
 * @param {number} from 起始行（含）
 * @param {number} to 结束行（不含）
 * @param {(lineHtmlList: string[]) => void} onDone
 * @param {string} [language] 语言 id；不传则用最近一次 prepareLanguage 的结果
 * @return {void | (() => void)} 取消函数
 */
export const highlightWindow = (lines, from, to, onDone, language) => {
	if (!hljs.getLanguage(language)) return onDone(null);

	// 拼窗口文本；顺便统计长度，太长就放弃高亮
	const count = Math.min(to, lines.length) - from;
	if (count <= 0) return onDone(null);

	const parts = new Array(count);
	let chars = 0;
	for (let i = 0; i < count; i++) {
		const t = lines[from + i].text;
		parts[i] = t;
		chars += t.length + 1;
	}
	if (chars > MAX_WINDOW_CHARS) return onDone(null);

	let cancelled = false;
	const gen = hljs.highlight(parts.join("\n"), {language, ignoreIllegals: true, _returnTokens: true});

	const step = () => {
		if (cancelled) return;
		const deadline = performance.now() + SLICE_MS;
		let r = gen.next();
		while (!r.done && performance.now() < deadline) r = gen.next();
		if (r.done) {
			if (!cancelled) onDone(r.value.value.map(line => {
				let end = 0;
				const output = [];
				line.forEach(item => {
					end += item.text.length;
					output.push(end, item.className);
				});
				return output;
			}));
			return;
		}
		queueMacrotask(step);
	};
	queueMacrotask(step);

	return () => {
		cancelled = true;
	};
};
