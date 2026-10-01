import {copyButtonAnimation, downloadFile} from "../utils/utils.js";

import {createMarkdownRenderer} from "./renderer.js";
import {createMarkdownParser} from "fastmd";

import "./markdown.css";

export const HTMLTagKinds = {
	basic: [
		"details", "summary",
		"b", "i", "u", "p", "br", "em", "kbd", "q", "strong", "code", "ruby", "rp", "rt", "sup", "sub", "small", "center",
		"h1", "h2", "h3", "h4", "h5", "h6",
		"table", "th", "tr", "td", "thead", "tbody", "pre",
		"ul", "ol", "li",
		"section",  "div", "span", "hr", "mark",
		"img", "a",
	],
	style: ["style"],
};

const mdParserOptions = {
	allowedTags: HTMLTagKinds.basic,
	parseQuotes: true,
	preserveLineBreaks: true,
	allowNestedCodeFence3: true
}

/**
 *
 * @param {string[]} tagTypes
 */
export const setAllowHTMLTags = (tagTypes) => {
	const arr = [];
	if (tagTypes) for (let type of tagTypes) {
		arr.push(...HTMLTagKinds[type]);
	}
	mdParserOptions.allowedTags = arr;
}

const SLICE_PER_FRAME = 10000;

/**
 *
 * @param {HTMLElement} container
 * @param {string} md
 * @param {import("fastmd").ParserOptions & AiChat.MarkdownRendererOptions} options
 */
export const renderMarkdownToElement = (container, md, options = {}) => {
	const renderer = createMarkdownRenderer(container, options);
	const parser = createMarkdownParser(renderer, {
		...mdParserOptions,
		...options
	});

	let i = 0;
	const chunkedRender = () => {
		parser.write(md.slice(i, i += SLICE_PER_FRAME));
		if (i >= md.length) parser.end();
		else requestAnimationFrame(chunkedRender);
	};
	chunkedRender();
	return container;
};

const relayoutNodes = el => {
	let result = '';
	for (const node of el.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			result += node.textContent;
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			result += relayoutNodes(node);
			if (/^(P|DIV|LI|H[1-6]|BLOCKQUOTE|TR|PRE|TABLE)$/.test(node.tagName)) {
				result += '\n';
			}
		}
	}
	return result;
};

/**
 *
 * @param {string} md
 * @param {boolean} [plaintext]
 * @return {string}
 */
export const renderMarkdownToString = (md, plaintext) => {
	const root = <div />;

	const renderer = createMarkdownRenderer(root, {
		noHighlight: true,
		noImage: true
	});
	const parser = createMarkdownParser(renderer, {
		...mdParserOptions,
		parseQuotes: false,
	});
	parser.write(md);
	parser.end();

	return plaintext ? relayoutNodes(root) : root.innerHTML;
};

const LANGUAGE_TO_EXT = {
	javascript: 'js',
	typescript: 'ts',
	python: 'py',
	csharp: 'cs',
	rust: 'rs',
	ruby: 'rb',
	kotlin: 'kt',
	markdown: 'md',
	batch: 'bat',
	bash: 'sh',
	shell: 'sh',
	powershell: 'ps1',
	objectivec: 'mm',
	text: 'txt',
	mermaid: 'txt'
};

export {registerCodeBlockRenderer} from './renderer.js';

export const copyCodeEventHandler = (e) => {
	const btn = e.target.closest(".code-block button[data-action]");
	if (!btn) return;

	const code = btn.closest('.sticky').nextElementSibling;
	switch (btn.dataset.action) {
		case "copy": {
			copyButtonAnimation(code._value || code.textContent, btn);
		}
		break;
		case "save": {
			const span = btn.parentElement.previousElementSibling;
			const filename = span.dataset.name;
			const lang = span.innerHTML.toLowerCase();

			const file = new (filename?File:Blob)([code._value || code.textContent], filename);
			downloadFile(file, LANGUAGE_TO_EXT[lang] ?? lang);
		}
		break;
	}
};

const rendererOptions = { stream: true };

/**
 *
 * @param {HTMLElement} output
 * @param [options]
 * @return {import("fastmd").Parser}
 */
export const createStreamingMarkdownParser = (output, options) => {
	return createMarkdownParser(
		createMarkdownRenderer(output, rendererOptions),
		{...mdParserOptions, stream: true, ...options}
	);
};

function STATE(parser) {
	let buf = '';
	let pos = 0;
	let end = false;

	const update = () => {
		let lim = pos + SLICE_PER_FRAME;
		const len = buf.length;
		parser.write(buf.slice(pos, Math.min(lim, len)));
		if (lim >= len) {
			lim = len;
			if (end) parser.end();
		} else {
			requestAnimationFrame(update)
		}
		pos = lim;
	}

	return {
		set(text) {
			buf = text;
			update();
		},
		end() {
			if (pos === buf.length) parser.end();
			end = true;
		}
	}
}

/**
 *
 * @return {(function(string, HTMLElement, Object): void)|*}
 */
export const createMarkdownStream = () => {
	let parser;
	let prevDOM;

	return (str, dom, options) => {
		if (prevDOM !== dom) {
			if (parser) {
				parser.end();
				parser = null;
			}
			if (!(prevDOM = dom)) return;

			dom.replaceChildren();// 这个给AntiSlop的重试循环用

			parser = STATE(createStreamingMarkdownParser(dom, options));
		}
		if (!str || !parser) return;

		parser.set(str);
	};
};
