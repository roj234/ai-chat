// Markdown renderer
import markdownIt from 'markdown-it';
import mk from 'markdown-it-katex';
import 'katex/dist/katex.min.css';
import {hljs} from '../assets/highlight.min.js';
import '../assets/github-dark.min.css'; // 选择合适的样式
import {copy} from "./utils.js";
import {formatDate} from "unconscious/ext/Utils.js";

const LANGUAGE_TO_EXT = {
	javascript: 'js',
	typescript: 'ts',
	python: 'py',
	csharp: 'cs',
	rust: 'rs',
	ruby: 'rb',
	kotlin: 'kt',
	markdown: 'md',
	bash: 'sh',
	shell: 'sh',
	powershell: 'ps1',
	objectivec: 'mm',
	text: 'txt'
};

function getHighlightHtml(str, lang) {
	return `<pre class="code-block language-${lang}"><div class="code-header sticky"><span>${lang || 'text'}</span><span><button class="i download" data-action="download" title="下载代码"></button><button class="i copy" data-action="copy" title="复制代码"></button></span></div><code class="hljs">${str}</code></pre>`;
}

export function getElementToCopy(el) {
	return el.parentElement.parentElement.nextElementSibling;
}

export const copyCodeEventHandler = (e) => {
	const btn = e.target.closest(".code-block button[data-action]");
	if (!btn) return;
	switch (btn.dataset.action) {
		case "copy": {
			copy(getElementToCopy(btn).innerText, btn);
		}
		break;
		case "download": {
			const url = URL.createObjectURL(new Blob([getElementToCopy(btn).innerText]));
			const lang = btn.parentElement.previousElementSibling.innerHTML.toLowerCase();
			const el = <a download={"aichat-"+formatDate("Y-m-d H_i_s")+"."+(LANGUAGE_TO_EXT[lang] ?? lang)} href={url}></a>;
			el.click();
			URL.revokeObjectURL(url);
		}
		break;
	}
};

export const markdown = /*#__PURE__*/ markdownIt({
	//linkify: true,
	highlight: function (str, lang) {
		if (lang === "chart") {
			// 返回一个占位符，图表会在后续渲染
			return `<div class="chart-loading" data-id="${str.trim()}"><div class="bar1"><div></div></div><div class="bar2"><div></div></div><div class="bar3"><div></div></div><div class="bar4"><div></div></div><div class="bar5"><div></div></div><span>图表加载中...</span></div></div>`;
		}

		try {
			if (lang && hljs.getLanguage(lang)) {
				const highlighted = hljs.highlight(str, {language: lang, ignoreIllegals: true}).value;
				return getHighlightHtml(highlighted, lang);
			}
		} catch {}

		return getHighlightHtml(markdown.utils.escapeHtml(str), lang);
	}
}).use(mk);

const streamFast = /*#__PURE__*/ markdownIt({highlight: (str, lang) => {
	// Escape to make removeLastTopLevelElement work properly
	return getHighlightHtml(markdown.utils.escapeHtml(str), lang);
}});

const VOID_TAG = /*#__PURE__*/ new Set(["area","base","br","col","embed","hr","img","input","link","meta","source","track","wbr"]);

/**
 *
 * @param {string} originalHtml
 * @return {string|false}
 */
function removeLastTopLevelElement(originalHtml) {
	//if (typeof originalHtml !== 'string') return false;

	// 纯文本
	const lastTag = originalHtml.lastIndexOf('>') + 1;
	if (!lastTag) return '';

	// 尾部文本
	const trailer = originalHtml.substring(lastTag);
	if (trailer.trim()) {
		if (!trailer.includes('<'))
			return originalHtml.substring(0, lastTag);

		console.error("未闭合的标签", trailer);
		return false;
	}

	const tagRegex = /^<\/?([a-zA-Z][a-zA-Z0-9-]*).*?\/?>/;
	const tagStack = [];
	let i = originalHtml.length;

	while (true) {
		const prev = originalHtml.lastIndexOf('<', i-1);
		if (prev < 0) {
			console.error("未打开的标签", tagStack[tagStack.length-1]);
			return false;
		}

		const match = tagRegex.exec(originalHtml.substring(prev, i));
		if (!match) {
			console.error("非法的标签", originalHtml.substring(prev, i));
			return false;
		}
		i = prev;

		const [m, tagName] = match;
		if (m.startsWith("</")) {
			// closing
			tagStack.push(tagName);
		} else {
			if (!VOID_TAG.has(tagName) && !m.endsWith("/>")) {
				const expectedTag = tagStack.pop();
				if (expectedTag !== tagName) {
					console.error("不匹配的标签", expectedTag, tagName);
					return false;
				}
			}

			if (tagStack.length === 0) break;
		}
	}

	return originalHtml.substring(0, i);
}

export function markdownStreamParser() {
	let oldHtml = '';
	let stableMarkdownBlock = 0;
	let prevShrink = 0;
	let lastElement = null;

	function skip(buffer) {
		stableMarkdownBlock = buffer.length;
	}

	/**
	 * @param {string} buffer
	 * @param {HTMLElement} output
	 */
	function render(buffer, output) {
		if (buffer.length < stableMarkdownBlock) {
			stableMarkdownBlock = 0;
			prevShrink = 0;
		}

		let unstableWrapper = output.querySelector('.unstableWrapper');
		if (!unstableWrapper) {
			if (lastElement && lastElement !== output) {
				lastElement = output;
				output.insertAdjacentHTML("afterbegin", markdown.render(buffer.substring(0, stableMarkdownBlock)));
			}

			unstableWrapper = <div className='unstableWrapper'></div>;
			output.append(unstableWrapper);
		}

		buffer = buffer.substring(stableMarkdownBlock);
		let newHtml = streamFast.render(buffer);

		const stableBlock = removeLastTopLevelElement(newHtml);
		if (stableBlock) {
			let found = false;
			for (let shrinkSize = 1; shrinkSize < buffer.length - prevShrink; shrinkSize++) {
				const mdLen = buffer.length - shrinkSize;

				// 尽可能长的匹配字符串
				// 二分可以得到近似结果，但事实上不是线性关系，所以得不到精确结果
				const tmpHtml = streamFast.render(buffer.substring(0, mdLen));
				if (tmpHtml === stableBlock) {
					found = true;

					unstableWrapper.insertAdjacentHTML('beforebegin', markdown.render(buffer.substring(0, mdLen)));
					stableMarkdownBlock += mdLen;

					newHtml = newHtml.substring(stableBlock.length);
					oldHtml = oldHtml.substring(stableBlock.length);
					break;
				}
			}

			prevShrink = found ? 0 : buffer.length;
		}

		let startMatch = 0;
		for (; startMatch < oldHtml.length; startMatch++) {
			if (newHtml[startMatch] !== oldHtml[startMatch]) break;
		}

		let endMatchMax = oldHtml.length - startMatch;
		let endMatch = 0;
		for (; endMatch < endMatchMax; endMatch++) {
			if (newHtml[newHtml.length - 1 - endMatch] !== oldHtml[oldHtml.length - 1 - endMatch]) break;
		}

		block:
		if (startMatch+endMatch >= oldHtml.length) {
			const endMarkers = oldHtml.substring(oldHtml.length - endMatch).split("</");
			let partialHtml = newHtml.substring(startMatch, newHtml.length - endMatch);
			if (partialHtml.indexOf("</") >= 0) break block;
			if (appendPartialHtml(partialHtml, endMarkers, unstableWrapper)) break block;

			oldHtml = newHtml;
			return;
		}

		oldHtml = newHtml;
		unstableWrapper.innerHTML = newHtml;
	}

	function appendPartialHtml(partialHtml, endMarkers, outputDiv) {
		let target = outputDiv;
		let nestDepth = endMarkers.length;
		while (--nestDepth) {
			if (!target.lastElementChild) return true;

			target = target.lastElementChild;
		}

		const elementStart = partialHtml.indexOf("<");

		let before = elementStart < 0 ? partialHtml : partialHtml.substring(0, elementStart);
		let after = elementStart < 0 ? "" : partialHtml.substring(elementStart);

		if (before) {
			// avoid create new text nodes (especially in code blocks)
			before = unHTMLEntities(before);
			const lastChild = target.lastChild;
			if (lastChild instanceof Text) {
				lastChild.textContent += before;
			} else {
				target.appendChild(new Text(before));
			}
		}
		if (after) {
			target.insertAdjacentHTML('beforeend', after);
		}
	}

	return {render, skip};
}

const HTML_ESCAPE_REPLACE_RE = /&(?:amp|lt|gt|quot);/g
const HTML_REPLACEMENTS = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '\''
}

function unHTMLEntities(s) {
	return s.replace(HTML_ESCAPE_REPLACE_RE, (s) => HTML_REPLACEMENTS[s]);
}
