import {INDEX, VirtualList} from "unconscious/ext/VirtualList.js";
import {isEqual} from "/vendor/equals.js";
import {ONCE_EVENT} from "unconscious";

/**
 * @type {[number, number]}
 */
let start, end;
/**
 * @type {boolean}
 */
let isSelecting;

const _getSelection = () => {
	if (!end) return null;

	const [startLine, startOffset] = start;
	const [endLine, endOffset] = end;

	const isReverse = (startLine > endLine) || (startLine === endLine && startOffset > endOffset);
	return isReverse ? [end, start] : [start, end];
};

/**
 * 支持选择复制的虚拟列表，你没见过吧！
 * - TODO 支持移动端
 * @param {VirtualList} virtualList
 * @param {function(number): string} getRawText
 * @param {boolean=} hasLineNumberNode
 */
export function selectableVirtualListMixin(virtualList, getRawText, hasLineNumberNode) {
	const onMouseDown_GlobalOnce = (e) => {
		if (e.button !== 0) return; // 只处理左键
		start = end = null;
		removeEventListener('copy', onCopy);
		import.meta.env.DEV && console.log("reset");
	};

	const onMouseDown = (e) => {
		if (e.button !== 0) return;
		onMouseDown_GlobalOnce(e);
		wrapper.addEventListener("mousemove", onMouseMove);
		addEventListener('mouseup', onMouseUp, ONCE_EVENT);
	};

	const onMouseMove = () => {
		// 滚动过程中 anchorNode 离开视口会被移除
		const {anchorNode, anchorOffset} = getSelection();
		if (!anchorNode) return;
		start = _getLineCols(anchorNode, anchorOffset);

		wrapper.removeEventListener("mousemove", onMouseMove);
		addEventListener('copy', onCopy);
		addEventListener('mousedown', onMouseDown_GlobalOnce, ONCE_EVENT);
		isSelecting = true;

		import.meta.env.DEV && console.log("start found", start);
	};

	const setEnd = () => {
		const {focusNode, focusOffset} = getSelection();
		if (focusNode) {
			end = _getLineCols(focusNode, focusOffset);
			if (isEqual(start, end)) end = null;
			import.meta.env.DEV && console.log("end found", end);
		}
	};

	const onMouseUp = () => {
		isSelecting = false;
		wrapper.removeEventListener("mousemove", onMouseMove);
		if (start) setEnd();
	};

	const onCopy = (e) => {
		if (!end) setEnd();

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
		if (isSelecting) return;
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
	wrapper.addEventListener('scroll', () => requestAnimationFrame(_restoreSelection));

	const oldDestroy = virtualList.destroy;
	virtualList.destroy = () => {
		oldDestroy.call(virtualList);
		removeEventListener('copy', onCopy);
	};
}