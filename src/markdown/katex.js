import 'katex/dist/katex.min.css';
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";

export {renderToString} from 'katex';


// 以后如果类似的东西多了可以考虑放到util里面
/**
 * @param {string}   selector
 * @param {boolean}  [partial]
 * @return {HTMLElement[]}
 */
function getSelectedNodes(selector, partial = true) {
	const sel = window.getSelection();
	if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return [];

	const result = [];
	const seen = new Set();

	const push = (node) => {
		if (seen.has(node)) return;
		if (node.nodeType === Node.ELEMENT_NODE && !node.matches(selector)) return;
		seen.add(node);
		result.push(node);
	};

	for (let i = 0; i < sel.rangeCount; i++) {
		const range = sel.getRangeAt(i);

		let root = range.commonAncestorContainer;
		if (root.nodeType === Node.TEXT_NODE) continue;

		const walker = document.createTreeWalker(
			root,
			NodeFilter.SHOW_ELEMENT,
			{
				acceptNode(node) {
					if (!sel.containsNode(node, true)) return NodeFilter.FILTER_REJECT;

					if (node.nodeType === Node.ELEMENT_NODE) {
						// 元素自身不匹配 selector，但后代可能匹配 → SKIP 继续下钻
						if (!node.matches(selector)) return NodeFilter.FILTER_SKIP;
					}

					// 要求“完全选中”：部分选中的节点只 SKIP 自己，仍要下钻
					// （父元素未被完全选中时，子元素仍可能被完全选中）
					if (!partial && !sel.containsNode(node, false)) return NodeFilter.FILTER_SKIP;

					return NodeFilter.FILTER_ACCEPT;
				},
			}
		);

		let node = walker.nextNode();
		while (node) {
			push(node);
			node = walker.nextNode();
		}
	}

	return result;
}

addEventListener('copy', (e) => {
	const selection = getSelection();
	if (!selection || !selection.rangeCount || !e.clipboardData) return;

	const nodes = getSelectedNodes('[data-katex]');
	if (!nodes.length) return;

	const backup = nodes.map(item => {
		const child = item.children[0];
		item.replaceChildren(item.__value);
		return child;
	});

	queueMacrotask(() => {
		nodes.forEach((node, i) => {
			node.replaceChildren(backup[i]);
		})
	})
});