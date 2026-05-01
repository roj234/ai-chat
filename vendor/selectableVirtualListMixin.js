import {INDEX, VirtualList} from "unconscious/ext/VirtualList.js";
import {isEqual} from "/vendor/equals.js";

/**
 * @param {VirtualList} virtualList
 * @param {function(number): string} getRawText
 * @param {boolean=} hasLineNumberNode
 */
export function selectableVirtualListMixin(virtualList, getRawText, hasLineNumberNode) {
	/**
	 *
	 * @type {{
	 * start: [number, number],
	 * end: [number, number],
	 * state: boolean
	 * }}
	 */
	const selection = {};

	const _getSelection = () => {
		const { start, end } = selection;
		if (!end) return null;

		const [startLine, startOffset] = start;
		const [endLine, endOffset] = end;

		const isReverse = (startLine > endLine) || (startLine === endLine && startOffset > endOffset);
		return isReverse ? [end, start] : [start, end];
	};

	const onMouseDown = (e) => {
		if (e.button !== 0) return; // 只处理左键
		selection.start = selection.end = null;
		selection.state = true;
	};

	const onMouseMove = () => {
		if (selection.state && !selection.start) {
			const sel = getSelection();
			if (!sel.anchorNode) return;
			selection.start = selection.end = _getLineCols(sel.anchorNode, sel.anchorOffset);
		}
	};

	const onMouseUp = () => {
		if (!selection.state || !selection.start) return;
		selection.state = false;
		const sel = getSelection();
		if (sel.focusNode) {
			selection.end = _getLineCols(sel.focusNode, sel.focusOffset);
			if (isEqual(selection.start, selection.end)) {
				selection.end = null;
			}
		}
	};

	const onCopy = (e) => {
		const range = _getSelection();
		if (range) {
			e.preventDefault();
			e.clipboardData.setData('text/plain', _getSelectedText(range));
		}
	};

	const _getLineCols = (node, offset) => {
		const lineEl = node.nodeType === Node.ENTITY_NODE ? node.closest('.line') : node.parentElement?.closest('.line');
		if (!lineEl) return null;

		const lines = parseInt(lineEl[INDEX]);
		const columns = _offsetToColumn(lineEl, node, offset);
		return [lines, columns];
	};

	/**
	 * 文本元素相对偏移转换为整行绝对偏移
	 * @param {Element} line
	 * @param {Node} targetNode
	 * @param {number} targetOffset
	 * @return {number}
	 * @private
	 */
	const _offsetToColumn = (line, targetNode, targetOffset) => {
		let offset = 0;
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		if (hasLineNumberNode) walker.nextNode(); // 跳过行号
		while (walker.nextNode()) {
			const node = walker.currentNode;
			if (node === targetNode) return offset + Math.min(targetOffset, node.length);
			offset += node.length;
		}
		return offset;
	};

	/**
	 * 整行绝对偏移转换为文本元素相对偏移
	 * @param {Element} line
	 * @param {number} column
	 * @return {null|[Node, number]}
	 * @private
	 */
	const _columnToOffset = (line, column) => {
		let offset = 0;
		const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
		if (hasLineNumberNode) walker.nextNode(); // 跳过行号
		let lastNode = null;
		while (walker.nextNode()) {
			lastNode = walker.currentNode;
			const len = lastNode.length;
			if (offset + len >= column) {
				return [lastNode, column - offset];
			}
			offset += len;
		}
		return lastNode && [lastNode, lastNode.length];
	};

	const _restoreSelection = () => {
		if (selection.state) return;
		const range = _getSelection();
		if (!range) return;

		const [[startLine, startOffset], [endLine, endOffset]] = range;
		const startDom = virtualList.getValue(startLine);
		const endDom = virtualList.getValue(endLine);

		let startRange = startDom ? _columnToOffset(startDom, startOffset) : null;
		let endRange = endDom ? _columnToOffset(endDom, endOffset) : null;

		// 处理选区超出可视范围的情况
		if (!startRange) {
			const first = virtualList.dom.firstElementChild;
			if (first[INDEX] > endLine) return;
			startRange = [first, 0];
		}
		if (!endRange) {
			const last = virtualList.dom.lastElementChild;
			if (last[INDEX] < startLine) return;
			endRange = _columnToOffset(last, 1e9);
		}

		if (startRange && endRange) {
			getSelection().setBaseAndExtent(startRange[0], startRange[1], endRange[0], endRange[1]);
		}
	};

	const _getSelectedText = ([[startLine, startOffset], [endLine, endOffset]]) => {
		let lines = '';
		for (let i = startLine; i <= endLine; i++) {
			const raw = getRawText(i);
			const startIdx = (i === startLine) ? startOffset : 0;
			const endIdx = (i === endLine) ? endOffset : raw.length;
			lines += raw.slice(startIdx, endIdx);
			if (i !== endLine) lines += '\n';
		}
		return lines;
	};

	// 事件绑定与销毁
	const wrapper = virtualList._wrapper;
	wrapper.addEventListener('mousedown', onMouseDown);
	wrapper.addEventListener('mousemove', onMouseMove);
	wrapper.addEventListener('scroll', () => requestAnimationFrame(_restoreSelection));
	document.addEventListener('mouseup', onMouseUp);
	document.addEventListener('copy', onCopy);

	const oldDestroy = virtualList.destroy;
	virtualList.destroy = () => {
		oldDestroy.call(virtualList);
		wrapper.removeEventListener('mousedown', onMouseDown);
		wrapper.removeEventListener('mousemove', onMouseMove);
		document.removeEventListener('mouseup', onMouseUp);
		document.removeEventListener('copy', onCopy);
	};
}