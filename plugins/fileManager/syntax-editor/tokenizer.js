/**
 * 行渲染：分词，选区，HTML 片段
 * - 依赖修改的vendored的HLJS Core注入的特殊配置项
 */

import hljs from "/vendor/hljs/core.js";
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";

const MAX_RENDER_CHARS = 10000;
const MAX_HIGHLIGHT_CHARS = 256000;

/**
 * @param {HTMLSpanElement} node
 * @param {string} text 行文本
 * @param {?number[]} tokens 分词结果；null 表示还没算出来，按纯文本渲染
 * @param {number} selFrom 选区起点（-1 表示无选区）
 * @param {number} selTo 选区终点
 * @return {void}
 */
export const lineDOM = (node, text, tokens, selFrom, selTo) => {
	node.replaceChildren();

	const hasSel = selFrom >= 0 && selTo > selFrom;

	if (!tokens?.length) tokens = [text.length, ''];

	let start = 0;
	for (let i = 0; i < tokens.length; i += 2) {
		let end = tokens[i];
		const cls = tokens[i + 1];

		const overflow = end - start > MAX_RENDER_CHARS;
		if (overflow) end = start + MAX_RENDER_CHARS;

		if (!hasSel || selTo <= start || selFrom >= end) {
			const part = text.slice(start, end);
			node.append(cls ? <span className={cls}>{part}</span> : part);
		} else {
			const a = Math.max(start, selFrom);
			const b = Math.min(end, selTo);

			const array = [];

			if (a > start) array.push(text.slice(start, a));
			array.push(<span className="-sel">{text.slice(a, b)}</span>);
			if (b < end) array.push(text.slice(b, end))

			if (cls) node.append(<span className={cls}>{array}</span>);
			else node.append(...array);
		}

		if (overflow) {
			node.append(<span className="-trunc">… 已折叠剩余 {text.length.toLocaleString("en-US")} 字符</span>);
			break;
		}

		start = end;
	}
};

/* ------------------------------------------------------------------ *
 * 语言与高亮任务
 * ------------------------------------------------------------------ */

/** 每个宏任务里最多连续跑多少毫秒。 */
const SLICE_MS = 5;

export const isSameLanguage = (la, lb) => hljs.getLanguage(la) === hljs.getLanguage(lb);

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
	if (chars > MAX_HIGHLIGHT_CHARS) return onDone(null);

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
