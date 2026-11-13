import "./TextEditor.css";
import {$cleanup} from "unconscious";
import {INDEX, VirtualList} from "unconscious/common/VirtualList.js";
import {advancePos, History, TextDocument} from "./syntax-editor/document.js";
import {loadLanguage} from "/src/markdown/highlight.js";
import {highlightWindow, isSameLanguage, lineDOM} from "./syntax-editor/tokenizer.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {openContextMenu} from "/src/components/Menu.js";
import {copyWithAnimation} from "/src/utils/utils.js";
import {normalizeLineTerminator} from "@roj234/shared/strings";
import {AS_IS} from "@roj234/shared";

/**
 * 虚拟列表 + 自绘光标/选区的语法高亮编辑器
 */

const TAB = "\t";
const WORD_BREAK = new Set(" \t\r\n,:\"'[]{}()=;".split(""));

/** 窗口上沿往上带这么多行上下文 */
const HL_CONTEXT = 5;
/** 窗口尾部扩展长度 */
const HL_TAIL = 32;
/** 起点对不上时往上翻倍，最多翻到可见区上沿往上这么多行 */
const HL_CONTEXT_MAX = 200;
/** 用窗口顶端这几行的旧 token 校验起点 */
const HL_PROBE = 3;

const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;

const clonePos = (p) => ({line: p.line, ch: p.ch});

/**
 *
 * @param {{
 *     lineHeight?: number,
 *     language?: string,
 *     onChange?: Function,
 *     onStatus?: Function,
 *     onContextMenu?: Function,
 *     autofocus?: boolean,
 *     placeholder?: string,
 *     readOnly?: boolean,
 *     value?: string,
 *     onReady?: Function,
 *     vPad?: number,
 * }} props
 * @return {{
 * element: HTMLElement,
 * focus: () => void,
 * blur: () => void,
 * refresh: () => void,
 *
 * getDocument: () => TextDocument,
 *
 * getValue: () => string,
 * setValue: (string) => void,
 *
 * isReadOnly: () => boolean,
 * setReadOnly: (boolean, boolean) => void,
 *
 * getLanguage: () => string,
 * setLanguage: (string) => Promise<void>,
 *
 * canUndo: () => boolean,
 * canRedo: () => boolean,
 * undo: () => void,
 * redo: () => void,
 *
 * getSelectedText: () => string,
 * scrollToLine: (number) => void,
 * insertText: (string) => void,
 * selectAll: () => void,
 * setErrorLine: (number) => void,
 * }}
 */
export const TextEditor = (props) => {
	const LH = props.lineHeight || 20;
	let langId = props.language || "plaintext";
	const onChange = props.onChange;
	const onStatus = props.onStatus;
	const autofocus = !!props.autofocus;
	const placeholder = props.placeholder || "";

	let vPadding = props.vPad ?? 4;
	let readOnly = !!props.readOnly;

	const doc = new TextDocument(props.value || "");
	const history = new History();

	/** @type {Pos} */
	let anchor = {line: 0, ch: 0};
	/** @type {Pos} */
	let head = {line: 0, ch: 0};
	let preferredCh = 0;

	let errorLine = -1;
	let emitTimer = 0;
	let curDigits = 0;
	let gutterWidth = 0;
	let gutterKey = "";
	/** 光标在「内容坐标系」下的 x，滚动时直接复用，避免每帧测量 */
	let caretContentX = null;
	let stopDrag = null;

	/** 文档版本：每次改动 +1，算到一半文档变了就作废 */
	let docVer = 0;
	/** token 可信区间 [hlFrom, hlTo)，区间外的行可能已经过期 */
	let hlFrom = -1;
	let hlTo = -1;
	/** 待重算的最小行号（-1 表示没有）：改动点以上的行文本没变，token 一定还有效 */
	let editLine = -1;
	let hlTimer = 0;
	let cancelHl = null;
	/** 正在算的范围 {ver, from, to}：滚动时若已被它覆盖，就不用重复发起 */
	let hlPending = null;
	/** 语言包是否已加载完 */
	let hlReady = false;
	let hlTriggerCount = 0;

	/** @type {HTMLElement} */
	let el, scrollEl, gutterEl, gutterInner, errMark, phEl;
	/** @type {HTMLTextAreaElement} */
	let inputEl;
	/** @type {VirtualList} */
	let vl;

	/* ------------------------------------------------------------------ *
	 * 选区
	 * ------------------------------------------------------------------ */

	let selectFrom, selectTo, isSelected = false;
	const selectionChanged = () => {
		[selectFrom, selectTo] = getSelection();
		isSelected = selectFrom.line !== selectTo.line || selectFrom.ch !== selectTo.ch;
	};

	const getSelection = () => {
		const a = anchor;
		const b = head;
		return (a.line < b.line || (a.line === b.line && a.ch <= b.ch)) ? [a, b] : [b, a];
	};

	const getSelectedText = () => isSelected ? doc.textInRange(selectFrom, selectTo) : "";

	const setSelection = (a, b) => {
		anchor = clonePos(a);
		head = clonePos(b);
		preferredCh = head.ch;
		refresh();
		report();
	};

	/* ------------------------------------------------------------------ *
	 * 绘制
	 * ------------------------------------------------------------------ */

	const updateGutterWidth = () => {
		const digits = String(doc.lines.length).length;
		if (digits !== curDigits) {
			curDigits = digits;
			el.style.setProperty("--digits", digits);
			gutterWidth = 0;
		}
	};

	/** 清空全部高亮结果（换语言 / 换全文时用） */
	const clearTokens = () => {
		const lines = doc.lines;
		for (let i = 0; i < lines.length; i++) lines[i].tokens = null;
		hlFrom = -1;
		hlTo = -1;
		editLine = -1;
		hlPending = null;
	};

	/**
	 * 标记 line 及以下的高亮失效。
	 * line 以上的行文本没动，token 依然准，所以重算从 line 附近往下走就够了。
	 */
	const markDirty = (line) => {
		if (editLine < 0 || line < editLine) editLine = line;
		if (hlTo > line) hlTo = line;
		if (hlTo <= hlFrom) {
			hlFrom = -1;
			hlTo = -1;
		}
	};

	const sameTokens = (a, b) => {
		if (!a || !b || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	};

	const runHighlight = () => {
		if (!hlReady) return;
		hlTriggerCount = 0;
		hlTimer = 0;

		const total = doc.lines.length;
		const vh = Math.ceil(scrollEl.clientHeight / LH) + 2;
		const first = Math.max(0, Math.floor(scrollEl.scrollTop / LH));
		const to = Math.min(total, first + vh + HL_TAIL);
		/** 起点最多回溯到这里 */
		const floor = Math.max(0, first - HL_CONTEXT_MAX);

		// 起点：可见区上沿往上只带几行上下文，剩下的交给 token 对照
		let from = Math.max(0, first - HL_CONTEXT);
		// 改动点在窗口之上（改完又滚走了）：改动点以下都过期，得从改动行接着往下算
		if (editLine >= 0 && editLine < from) from = Math.max(0, editLine - 1);
		// 上次可信区间从更靠上的行开始：这次进了没校验过的区域，退回大上下文
		if (hlFrom >= 0 && from < hlFrom) from = floor;
		if (from < floor) from = floor;

		if (from >= hlFrom && to <= hlTo) return;
		if (hlPending && hlPending.ver === docVer && hlPending.from <= from && to <= hlPending.to) return;

		cancelHl?.();
		cancelHl = null;
		hlPending = null;

		const ver = docVer;
		const reqLang = langId;
		/** 对照只认改动点以上的行：改动点以下本来就会跟着变 */
		const probeEnd = editLine > from ? editLine : Infinity;
		let start = from;
		let ctx = HL_CONTEXT;

		/**
		 * 校验窗口起点：拿顶端几行的旧 token 对照。
		 * - 一致：起始状态没变（或者起点正好落在跨行构造之外），整窗可信
		 * - 不一致：起点落进了跨行构造里，窗口顶端的行会被算错 → 起点往上翻倍重来
		 * @param {number} from
		 * @param {number[]} tokens 本次算出来的 token
		 * @return {number} 新的起点；-1 表示可信 / 已经扩到头
		 */
		const retryFrom = (from, tokens) => {
			const n = Math.min(HL_PROBE, tokens.length, probeEnd - from);
			let compared = 0;
			for (let i = 0; i < n; i++) {
				const old = doc.lines[from + i]?.tokens;
				if (!old) continue;
				compared++;
				if (!sameTokens(old, tokens[i])) {
					ctx *= 2;
					// 相对当前起点往上翻倍（起点可能已经被改动行顶到可视区之上）
					const next = Math.max(floor, from - ctx);
					return next < from ? next : -1;
				}
			}
			// 顶端这几行一条旧 token 都没有：无从校验，按老办法用大上下文兜底
			if (!compared && from > floor) return floor;
			return -1;
		};

		const run = () => {
			hlPending = {ver, from: start, to};
			cancelHl = highlightWindow(doc.lines, start, to, (tokens) => {
				// null 返回是即时的
				if (!tokens) {
					cancelHl = null;
					if (ver !== docVer) return;
					hlPending = null;
					hlFrom = start;
					hlTo = to;
					if (editLine >= 0 && editLine < to) editLine = -1;
					return;
				}

				cancelHl = null;
				// 算的过程中文档又改了，结果作废（applyChange 会再排一次）
				if (ver !== docVer) return;

				if (start > 0) {
					const next = retryFrom(start, tokens);
					if (next >= 0) {
						start = next;
						run();
						return;
					}
				}

				hlPending = null;
				hlFrom = start;
				hlTo = to;

				for (let i = 0; i < tokens.length; i++) {
					doc.lines[start + i].tokens = tokens[i];
				}

				if (editLine >= 0 && editLine < to) editLine = -1;
				vl.render();
			}, reqLang);
		};
		run();
	};

	/** 防抖调度：输入时别把整窗口重排得太频繁 */
	const scheduleHighlight = () => {
		if (!hlReady || hlTriggerCount++ > 6) return;
		clearTimeout(hlTimer);
		hlTimer = setTimeout(runHighlight, 80);
	};

	/**
	 * 切换高亮语言：语言包按需动态 import，加载完再重算当前窗口。
	 * 返回 Promise，调用方可以 await 之后再刷新界面。
	 */
	const setLanguage = async (id) => {
		if (isSameLanguage(id, langId) && hlReady) return;
		if (langId) clearTokens();
		langId = id;
		hlReady = false;
		cancelHl?.();
		cancelHl = null;
		await loadLanguage(langId);
		hlReady = true;
		runHighlight();
	};

	const syncGutter = () => {
		if (!gutterWidth) {
			const w = gutterEl.getBoundingClientRect().width;
			if (w > 0) gutterWidth = w;
		}

		const start = vl._start;
		const end = vl._end;
		const top = scrollEl.scrollTop;
		const key = start+":"+end+":"+top+":"+errorLine;
		if (key === gutterKey) return;
		gutterKey = key;

		if (end > start) {
			let i = start + 1;
			let s = String(i);
			while (i < end) s += '\n' + ++i;
			gutterInner.textContent = s;
			gutterInner.style.transform = `translateY(${start * LH - top}px)`;
		} else {
			gutterInner.replaceChildren();
		}

		const hasError = errorLine >= 0 && errorLine < doc.lines.length;
		errMark.style.display = hasError ? "block" : "none";
		if (hasError) {
			errMark.style.transform = `translateY(${errorLine * LH - top}px)`;
		}
	};

	/**
	 * @param {HTMLElement} node
	 * @param line
	 * @param {number} index
	 */
	const syncLine = (node, line, index) => {
		let selFrom = -1, selTo = -1;
		if (isSelected && index >= selectFrom.line && index <= selectTo.line) {
			selFrom = index === selectFrom.line ? selectFrom.ch : 0;
			selTo = index === selectTo.line ? selectTo.ch : line.text.length;
		}

		if (node._tk !== line.tokens || node._from !== selFrom || node._to !== selTo) {
			node._tk = line.tokens;
			node._from = selFrom;
			node._to = selTo;
			lineDOM(node.firstElementChild, line.text, line.tokens, selFrom, selTo);
		}

		node.classList.toggle("-sel", isSelected && index > selectFrom.line && index < selectTo.line);
		node.classList.toggle("-hl", index === errorLine);
	};

	const paint = () => {
		vl.render();
		syncGutter();
	};

	/** 行内字符偏移 -> 屏幕 x */
	const caretXOfNode = (node, ch) => {
		const code = node.firstElementChild;
		const box = code.getBoundingClientRect();
		if (ch <= 0) return box.left;
		// 行内容还没同步（改完之后的新行节点）时不要返回行首，那会让光标跳到行开头
		if (!code.firstChild) return box.right;

		let acc = 0;
		const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
		let textNode;
		while ((textNode = walker.nextNode())) {
			const len = textNode.length;
			if (acc + len >= ch) {
				const range = document.createRange();
				range.setStart(textNode, Math.min(ch - acc, len));
				range.collapse(true);
				const rect = range.getClientRects()[0] || range.getBoundingClientRect();
				return rect ? rect.left : box.left;
			}
			acc += len;
		}
		return box.right;
	};

	const topOfLine = line => line * LH + vPadding;

	const caretPoint = () => {
		const node = vl.getValue(head.line);
		if (!node) return null;
		if (caretContentX == null) {
			const box = scrollEl.getBoundingClientRect();
			caretContentX = caretXOfNode(node, head.ch) - box.left + scrollEl.scrollLeft;
		}
		return {
			x: caretContentX - scrollEl.scrollLeft + gutterWidth,
			y: topOfLine(head.line) - scrollEl.scrollTop,
		};
	};

	const syncCaret = () => {
		const p = caretPoint();
		// 实验得出，这2px没有为什么
		inputEl.style = p ? `left:${p.x}px;top:${p.y}px` : "";
	};

	const scrollVertically = () => {
		const top = topOfLine(head.line);
		const st = scrollEl.scrollTop;
		const vh = scrollEl.clientHeight;
		if (top < st) scrollEl.scrollTop = top;
		else if (top + LH > st + vh) scrollEl.scrollTop = top + LH - vh;
	};

	const scrollHorizontally = () => {
		const node = vl.getValue(head.line);
		if (!node) return;
		const box = scrollEl.getBoundingClientRect();
		caretContentX = caretXOfNode(node, head.ch) - box.left + scrollEl.scrollLeft;
		const x = caretContentX - scrollEl.scrollLeft;
		const limit = scrollEl.clientWidth;
		if (x < gutterWidth + 4) scrollEl.scrollLeft += x - (gutterWidth + 4);
		else if (x > limit - 8) scrollEl.scrollLeft += x - (limit - 8);
	};

	/**
	 * 改了什么状态完全不知道时的兜底函数，保证没问题，但浪费性能
	 */
	const refresh = () => {
		caretContentX = null;
		selectionChanged();
		updateGutterWidth();
		scrollVertically();

		const keptLeft = scrollEl.scrollLeft;
		paint();
		if (keptLeft && scrollEl.scrollLeft !== keptLeft) scrollEl.scrollLeft = keptLeft;

		scrollHorizontally();
		syncCaret();

		const empty = doc.lines.length === 1 && doc.lines[0].text === "";
		phEl.style.display = empty && placeholder ? "block" : "none";

		// 可见区可能变了，排队重算一次（防抖）
		hlTriggerCount = 0;
		scheduleHighlight();
	};

	/* ------------------------------------------------------------------ *
	 * 状态上报
	 * ------------------------------------------------------------------ */

	const report = () => {
		if (!onStatus) return;
		const [a, b] = getSelection();
		let selected = 0;
		if (a.line !== b.line || a.ch !== b.ch) {
			if (a.line === b.line) selected = b.ch - a.ch;
			else {
				selected = doc.lines[a.line].text.length - a.ch + b.ch;
				for (let i = a.line + 1; i < b.line; i++) selected += doc.lines[i].text.length + 1;
			}
		}
		onStatus({
			line: head.line + 1,
			ch: head.ch + 1,
			lineCount: doc.lines.length,
			chars: doc.charCount,
			selected,
			rendered: vl.dom.childElementCount,
			total: doc.lines.length,
			readOnly,
		});
	};

	const scheduleEmit = () => {
		if (!onChange) return;
		clearTimeout(emitTimer);
		emitTimer = setTimeout(() => {
			emitTimer = 0;
			onChange(doc.text());
		}, 200);
	};

	/* ------------------------------------------------------------------ *
	 * 编辑
	 * ------------------------------------------------------------------ */

	const structureChanged = ({index, delta}) => {
		if (delta) {
			if (index < vl._start) vl._start = Math.max(0, vl._start + delta);
			vl._offset = vl._start * LH;
		}
		vl._height = doc.lines.length * LH;
	};

	const applyChange = (a, b, text, mergeKind) => {
		const before = {anchor: clonePos(anchor), head: clonePos(head)};

		const res = doc.replace(a, b, text);
		const after = advancePos(a, text);

		if (!res.delta) {
			// TODO 在插入或删除字符从场景下，应在高亮完成前复用原始行对象的tokens
		}

		docVer++;
		markDirty(res.index);

		anchor = clonePos(after);
		head = clonePos(after);
		preferredCh = after.ch;

		history.push({
			a: clonePos(a),
			b: clonePos(b),
			removed: res.removed,
			inserted: text,
			before,
			after: {anchor: clonePos(anchor), head: clonePos(head)},
		}, mergeKind);

		structureChanged(res);
		refresh();
		scheduleEmit();
		report();
	};

	const indentOfLine = (line) => {
		const text = doc.lines[line].text;
		let i = 0;
		while (i < text.length) {
			const c = text.charCodeAt(i);
			if (c !== 32 && c !== 9) break;
			i++;
		}
		return text.slice(0, i);
	};

	// 缩进单位：优先跟随文档已有风格（Tab / 最小正缩进），默认两空格
	let indentUnit = null;
	const detectIndentUnit = () => {
		const n = Math.min(doc.lines.length, 500);
		let best = 0;
		for (let i = 0; i < n; i++) {
			const t = doc.lines[i].text;
			let j = 0;
			while (j < t.length && (t.charCodeAt(j) === 32 || t.charCodeAt(j) === 9)) j++;
			if (j === 0) continue;
			if (t.charCodeAt(0) === 9) {
				indentUnit = "\t";
				return;
			}
			if (best === 0 || j < best) best = j;
		}
		indentUnit = " ".repeat(best || 2);
	};

	const insertText = (text) => {
		if (readOnly || !text) return;
		const [a, b] = getSelection();

		let insert = text;
		let mergeKind = null;
		if (text === "\n") {
			if (indentUnit === null) detectIndentUnit();
			const lineText = doc.lines[a.line].text;
			let base = indentOfLine(a.line);
			// 在 { 或 [ 之后回车，子层级多缩进一级
			const prev = a.ch > 0 ? lineText[a.ch - 1] : "";
			if (prev === "{" || prev === "[") base += indentUnit;
			insert = "\n" + base;
		} else if (text.length === 1) {
			mergeKind = "type";
		}
		applyChange(a, b, insert, mergeKind);
	};

	const deleteRange = (a, b, kind) => {
		if (readOnly) return;
		if (a.line === b.line && a.ch === b.ch) return;
		applyChange(a, b, "", kind);
	};

	const prevCharPos = (p) => {
		if (p.ch > 0) {
			const text = doc.lines[p.line].text;
			let ch = p.ch - 1;
			if (ch > 0 && isLowSurrogate(text.charCodeAt(ch)) && isHighSurrogate(text.charCodeAt(ch - 1))) ch--;
			return {line: p.line, ch};
		}
		if (p.line > 0) {
			const line = p.line - 1;
			return {line, ch: doc.lines[line].text.length};
		}
		return p;
	};

	const nextCharPos = (p) => {
		const text = doc.lines[p.line].text;
		if (p.ch < text.length) {
			let ch = p.ch + 1;
			if (ch < text.length && isHighSurrogate(text.charCodeAt(p.ch)) && isLowSurrogate(text.charCodeAt(ch))) ch++;
			return {line: p.line, ch};
		}
		if (p.line < doc.lines.length - 1) return {line: p.line + 1, ch: 0};
		return p;
	};

	const prevWordPos = (p) => {
		let {line, ch} = p;
		let text = doc.lines[line].text;
		if (ch === 0) {
			if (line === 0) return p;
			line--;
			text = doc.lines[line].text;
			ch = text.length;
		}
		while (ch > 0 && WORD_BREAK.has(text[ch - 1])) ch--;
		while (ch > 0 && !WORD_BREAK.has(text[ch - 1])) ch--;
		return {line, ch};
	};

	const nextWordPos = (p) => {
		let {line, ch} = p;
		let text = doc.lines[line].text;
		if (ch === text.length) {
			if (line === doc.lines.length - 1) return p;
			line++;
			text = doc.lines[line].text;
			ch = 0;
		}
		while (ch < text.length && WORD_BREAK.has(text[ch])) ch++;
		while (ch < text.length && !WORD_BREAK.has(text[ch])) ch++;
		return {line, ch};
	};

	const deleteBackward = (byWord) => {
		const [a, b] = getSelection();
		if (a.line !== b.line || a.ch !== b.ch) {
			deleteRange(a, b, null);
			return;
		}
		if (a.line === 0 && a.ch === 0) return;
		deleteRange(byWord ? prevWordPos(a) : prevCharPos(a), a, "back");
	};

	const deleteForward = (byWord) => {
		const [a, b] = getSelection();
		if (a.line !== b.line || a.ch !== b.ch) {
			deleteRange(a, b, null);
			return;
		}
		const last = doc.lines.length - 1;
		if (a.line === last && a.ch === doc.lines[a.line].text.length) return;
		deleteRange(a, byWord ? nextWordPos(a) : nextCharPos(a), "del");
	};

	const undo = () => {
		const entry = history.undo();
		if (!entry) return;
		const res = doc.replace(entry.a, advancePos(entry.a, entry.inserted), entry.removed);
		// 撤销可能改掉跨行构造，版本 +1 让高亮重算
		docVer++;
		markDirty(res.index);
		anchor = clonePos(entry.before.anchor);
		head = clonePos(entry.before.head);
		preferredCh = head.ch;
		structureChanged(res);
		history.pushRedo(entry);
		refresh();
		scheduleEmit();
		report();
	};

	const redo = () => {
		const entry = history.redo();
		if (!entry) return;
		const res = doc.replace(entry.a, advancePos(entry.a, entry.removed), entry.inserted);
		docVer++;
		markDirty(res.index);
		anchor = clonePos(entry.after.anchor);
		head = clonePos(entry.after.head);
		preferredCh = head.ch;
		structureChanged(res);
		history.pushUndo(entry);
		refresh();
		scheduleEmit();
		report();
	};

	const selectAll = () => {
		const last = doc.lines.length - 1;
		setSelection({line: 0, ch: 0}, {line: last, ch: doc.lines[last].text.length});
	};

	/* ------------------------------------------------------------------ *
	 * 光标移动
	 * ------------------------------------------------------------------ */

	const moveTo = (p, extend, keepPreferred) => {
		const target = doc.clamp(p);
		if (target.ch !== head.ch) caretContentX = null;
		if (extend) {
			head = target;
		} else {
			anchor = clonePos(target);
			head = clonePos(target);
		}
		if (!keepPreferred) preferredCh = target.ch;

		selectionChanged();
		scrollVertically();
		scrollHorizontally();
		paint();
		syncCaret();
		report();
	};

	const moveHorizontal = (dir, extend, byWord) => {
		const from = extend ? head : getSelection()[dir < 0 ? 0 : 1];
		const target = byWord
			? (dir < 0 ? prevWordPos(from) : nextWordPos(from))
			: (dir < 0 ? prevCharPos(from) : nextCharPos(from));
		moveTo(target, extend, false);
	};

	const moveVertical = (delta, extend) => {
		const last = doc.lines.length - 1;
		let line = head.line + delta;
		let ch = Math.min(preferredCh, doc.lines[line].text.length);

		if (line < 0) {
			line = 0;
			ch = 0;
		}
		else if (line > last) {
			line = last;
			ch = doc.lines[line].text.length;
		}

		moveTo({line, ch}, extend, true);
	};

	const pageLines = () => Math.max(1, Math.floor(scrollEl.clientHeight / LH) - 1);

	/* ------------------------------------------------------------------ *
	 * 命中测试
	 * ------------------------------------------------------------------ */

	const findLineNode = (node) => {
		let cur = node.nodeType === 1 ? node : node.parentElement;
		return cur.closest(".-line");
	};

	/** 段落内的坐标 -> 行内字符偏移 */
	const offsetInCode = (code, container, offset, lineLength, cx) => {
		if (!code.contains(container)) {
			const box = code.getBoundingClientRect();
			return cx != null && cx > box.left ? lineLength : 0;
		}

		if (container.nodeType === 3) {
			let acc = 0;
			const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
			let node;
			while ((node = walker.nextNode())) {
				if (node === container) return acc + Math.min(offset, node.length);
				acc += node.length;
			}
			return acc;
		}

		const point = document.createRange();
		point.setStart(container, Math.min(offset, container.childNodes.length));
		point.collapse(true);

		let acc = 0;
		const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
		let node;
		while ((node = walker.nextNode())) {
			if (point.comparePoint(node, 0) >= 0) break;
			acc += node.length;
		}
		return acc;
	};

	const caretRangeAt = (x, y) => {
		if (document.caretPositionFromPoint) {
			const p = document.caretPositionFromPoint(x, y);
			if (p) return [p.offsetNode, p.offset];
		} else {
			const range = document.caretRangeFromPoint?.(x, y);
			if (range) return [range.startContainer, range.startOffset];
		}
		return null;
	};

	const posFromPoint = (cx, cy) => {
		const range = caretRangeAt(cx, cy);
		if (range) {
			const lineNode = findLineNode(range[0]);
			if (lineNode) {
				const index = lineNode[INDEX];
				const len = doc.lines[index].text.length;
				const ch = offsetInCode(lineNode.firstElementChild, range[0], range[1], len, cx);
				return {line: index, ch: Math.max(0, Math.min(ch, len))};
			}
		}

		// 落在空白区域（行尾右侧、最后一行下方）
		const box = scrollEl.getBoundingClientRect();
		let index = Math.floor((cy - box.top + scrollEl.scrollTop) / LH);
		if (index < 0) index = 0;
		if (index >= doc.lines.length) {
			const last = doc.lines.length - 1;
			return {line: last, ch: doc.lines[last].text.length};
		}
		const node = vl.getValue(index);
		if (node && cx < node.firstElementChild.getBoundingClientRect().left) return {line: index, ch: 0};
		return {line: index, ch: doc.lines[index].text.length};
	};

	/* ------------------------------------------------------------------ *
	 * 鼠标
	 * ------------------------------------------------------------------ */

	const autoScroll = (cx, cy) => {
		const box = scrollEl.getBoundingClientRect();
		const edge = Math.min(28, box.height / 4);
		if (cy < box.top + edge) scrollEl.scrollTop -= LH * 3;
		else if (cy > box.bottom - edge) scrollEl.scrollTop += LH * 3;
		if (cx < box.left + edge) scrollEl.scrollLeft -= 60;
		else if (cx > box.right - edge) scrollEl.scrollLeft += 60;
	};

	const wordRangeAt = (p) => {
		const text = doc.lines[p.line].text;

		// 落在引号上（或字符串内部）时选中整个字符串
		let qStart = -1;
		const c = text[p.ch];
		if (c === "\"" || c === "'") qStart = p.ch;
		else if (p.ch > 0 && (text[p.ch - 1] === "\"" || text[p.ch - 1] === "'")) qStart = p.ch - 1;
		if (qStart >= 0) {
			const quote = text[qStart];
			let end = qStart + 1;
			while (end < text.length) {
				if (text[end] === "\\") { end += 2; continue; }
				if (text[end] === quote) return [{line: p.line, ch: qStart}, {line: p.line, ch: end + 1}];
				end++;
			}
		}

		let s = p.ch;
		let e = p.ch;
		while (s > 0 && !WORD_BREAK.has(text[s - 1])) s--;
		while (e < text.length && !WORD_BREAK.has(text[e])) e++;
		if (s === e) {
			if (e < text.length) e++;
			else if (s > 0) s--;
		}
		return [{line: p.line, ch: s}, {line: p.line, ch: e}];
	};

	const startDrag = (position, extend) => {
		stopDrag?.();

		if (extend) {
			head = position;
		} else {
			anchor = position;
			head = clonePos(position);
			preferredCh = position.ch;
		}

		caretContentX = null;
		selectionChanged();
		vl.render();
		syncCaret();

		report();

		const onMove = (e) => {
			autoScroll(e.clientX, e.clientY);
			head = posFromPoint(e.clientX, e.clientY);

			// 顺序不能变
			caretContentX = null;
			selectionChanged();
			vl.render();
			syncCaret();
		};
		const onUp = () => {
			stopDrag = null;
			removeEventListener("mousemove", onMove);
			removeEventListener("mouseup", onUp);
			report();
		};

		addEventListener("mousemove", onMove);
		addEventListener("mouseup", onUp);
		stopDrag = () => {
			removeEventListener("mousemove", onMove);
			removeEventListener("mouseup", onUp);
		};
	};

	const focus = () => {
		if (document.activeElement !== inputEl) inputEl.focus({preventScroll: true});
	};

	/**
	 * 点在滚动条上不能当成文本。
	 */
	const onScrollbar = (e) => {
		const box = scrollEl.getBoundingClientRect();
		return e.clientX >= box.left + scrollEl.clientWidth ||
			e.clientY >= box.top + scrollEl.clientHeight;
	};

	const onMouseDown = (e) => {
		const btn = e.button;
		if (btn !== 0 && (btn !== 2 || isSelected)) return;
		if (onScrollbar(e)) return;
		e.preventDefault();

		const position = posFromPoint(e.clientX, e.clientY);
		focus();

		if (e.detail >= 3) {
			setSelection({line: position.line, ch: 0}, {line: position.line, ch: doc.lines[position.line].text.length});
			return;
		}
		if (e.detail === 2) {
			const [a, b] = wordRangeAt(position);
			setSelection(a, b);
			return;
		}
		startDrag(position, e.shiftKey);
	};

	/* ------------------------------------------------------------------ *
	 * 事件处理器
	 * ------------------------------------------------------------------ */

	const onKeyDown = (e) => {
		if (e.isComposing || e.keyCode === 229) return;

		const mod = e.ctrlKey || e.metaKey;
		const shift = e.shiftKey;
		const key = e.key;

		switch (key) {
			case "ArrowLeft": moveHorizontal(-1, shift, mod); break;
			case "ArrowRight": moveHorizontal(1, shift, mod); break;
			case "ArrowUp": moveVertical(-1, shift); break;
			case "ArrowDown": moveVertical(1, shift); break;
			case "PageUp": moveVertical(-pageLines(), shift); break;
			case "PageDown": moveVertical(pageLines(), shift); break;
			case "Home":
				if (mod) moveTo({line: 0, ch: 0}, shift);
				else moveTo({line: head.line, ch: 0}, shift);
				break;
			case "End":
				if (mod) {
					const last = doc.lines.length - 1;
					moveTo({line: last, ch: doc.lines[last].text.length}, shift);
				} else {
					moveTo({line: head.line, ch: doc.lines[head.line].text.length}, shift);
				}
				break;
			case "Backspace":
				if (!readOnly) deleteBackward(mod);
				break;
			case "Delete":
				if (!readOnly) deleteForward(mod);
				break;
			case "Enter":
				if (!readOnly) insertText("\n");
				break;
			case "Tab":
				if (readOnly) return;
				 insertText(TAB);
				break;
			case "Escape":
				focus();
				break;
			default: {
				if (!mod) return;

				const lower = key.toLowerCase();
				switch (lower) {
					default: return;
					case "a": return selectAll();
					case "z": return shift ? redo() : undo();
					case "y": return redo();
					case "g":
						SimpleModal({
							title: "Go to line:column",
							type: "input",
							value: (head.line+1)+":"+(head.ch+1),
							onConfirm(value) {
								const n = value.split(':').map(s => parseInt(s.trim(), 10));
								if (!Number.isFinite(n[0]) || n[0] <= 0 || n[1] <= 0) return false;
								const a = { line: (n[0]-1), ch: (n[1]-1) || 0 };
								setSelection(a, a);
								focus();
							}
						});
						break;
				}
			}
		}

		e.preventDefault();
	};

	/* ------------------------------------------------------------------ *
	 * API
	 * ------------------------------------------------------------------ */

	const setValue = (text, keepScroll) => {
		clearTimeout(emitTimer);
		history.clear();
		doc.setText(text);
		indentUnit = null;
		docVer++;
		clearTokens();
		anchor = {line: 0, ch: 0};
		head = {line: 0, ch: 0};
		preferredCh = 0;
		errorLine = -1;
		vl._start = 0;
		vl._offset = 0;
		vl._height = doc.lines.length * LH;
		vl._dirty = true;
		if (!keepScroll) {
			scrollEl.scrollTop = 0;
			scrollEl.scrollLeft = 0;
		}
		if (selfVisible) {
			refresh();
			report();
		} else {
			pendingUpdate = true;
		}
	};

	const setReadOnly = (value, silent) => {
		readOnly = !!value;
		el.classList.toggle("-readonly", readOnly);
		if (!readOnly && !silent) focus();
		refresh();
	};

	const setErrorLine = (line, startCh, endCh) => {
		const next = line == null || line < 0 ? -1 : line;
		if (next === errorLine) return;
		errorLine = next;
		paint();
	};

	const scrollToLine = (line) => {
		const last = doc.lines.length - 1;
		const index = Math.max(0, Math.min(last, line | 0));
		scrollEl.scrollTop = Math.max(0, topOfLine(line) - Math.floor(scrollEl.clientHeight / LH / 2) * LH);
		setSelection({line: index, ch: 0}, {line: index, ch: 0});
	};

	/* ------------------------------------------------------------------ *
	 * 装配
	 * ------------------------------------------------------------------ */

	const onContextMenu = props.onContextMenu ?? AS_IS;

	el = <div className="vje -readonly" style={`--lh:${LH}px;--digits:1;--p:${vPadding}px`} onMouseDown={onMouseDown} onContextMenu.prevent={ev => {
		openContextMenu(ev, scrollEl, onContextMenu([
			{label: '撤销', icon: "ri-reset-left-line", disabled: !history.canUndo, act: undo},
			{label: '重做', icon: "ri-reset-right-line", disabled: !history.canRedo, act: redo},
			{ sep: true },
			{label: '剪切', icon: "ri-scissors-line", disabled: readOnly || !isSelected, act: () => {
				copyWithAnimation(getSelectedText());
				const [a, b] = getSelection();
				deleteRange(a, b, null);
			}},
			{label: '复制', icon: "ri-file-copy-line", disabled: !isSelected, act: () => copyWithAnimation(getSelectedText())},
			{label: '粘贴', icon: "ri-clipboard-line", disabled: readOnly, act: () => {
				navigator.clipboard.readText().then(text => {
					insertText(normalizeLineTerminator(text));
				});
			}},
			{label: '删除', icon: "ri-delete-bin-line", danger: true, disabled: readOnly || !isSelected, act: () => {
				const [a, b] = getSelection();
				deleteRange(a, b, null);
			}},
			{label: '全选', icon: 'ri-checkbox-multiple-line', act: selectAll},
			{ sep: true },
			{label: '查找/替换 (未实现)', icon: "ri-find-replace-line", disabled: true, act: () => {

			}},
			{label: `语言 (${langId})`, icon: "ri-global-line", act: () => {
				SimpleModal({
					title: "设置语法高亮的语言",
					placeholder: "下拉框尚未实现！",
					type: "input",
					onConfirm(id) {
						if (!loadLanguage(id, true)) return false;
						return setLanguage(id);
					}
				})
			}},
			{label: '自动换行 (未实现)', icon: "ri-text-wrap", disabled: true, act: () => {

			}},
		]), true);
	}}>
		<div className="-fade" />
		<div className="-gutter" ref={gutterEl}>
			<div className="-lines" ref={gutterInner}/>
			<div className="-hl" ref={errMark}/>
		</div>
		<div className="-container" ref={scrollEl} onScroll.passive={() => {
			syncGutter();
			syncCaret();
			// 不清 hlTriggerCount，保证至少 500ms 高亮一次，避免连续滚动时完全不高亮
			scheduleHighlight();
		}} />
		<div className="-empty" ref={phEl}>{placeholder}</div>
		<textarea className="-input" ref={inputEl} spellCheck={false} autoCapitalize={"off"} autoCorrect={"off"} wrap={"off"}
			onKeyDown={onKeyDown}

			onInput={(ev) => {
				if (ev.isComposing) {
					inputEl.style.width = "1px";
					inputEl.style.width = (inputEl.scrollWidth)+"px";
					return;
				}
				const value = inputEl.value;
				if (!value) return;
				inputEl.value = "";
				if (readOnly) return;
				insertText(value);
			}}
			onCompositionStart={() => {
				el.classList.add('-composing');
			}}
			onCompositionEnd={(ev) => {
				el.classList.remove('-composing');
				inputEl.style.width = "";
				const value = inputEl.value || ev.data;
				inputEl.value = "";
				if (!readOnly && value) insertText(value);
			}}

			onCopy={(ev) => {
				const text = getSelectedText();
				if (!text) return;
				ev.preventDefault();
				ev.clipboardData?.setData("text/plain", text);
			}}
			onCut={(ev) => {
				if (readOnly) return;
				const text = getSelectedText();
				if (!text) return;
				ev.preventDefault();
				ev.clipboardData?.setData("text/plain", text);
				const [a, b] = getSelection();
				deleteRange(a, b, null);
			}}
			onPaste={(ev) => {
				if (readOnly) return;
				ev.preventDefault();
				const text = ev.clipboardData?.getData("text/plain");
				if (!text) return;
				insertText(normalizeLineTerminator(text));
			}}

			onFocus={() => el.classList.add("-focused")}
			onBlur={() => el.classList.remove("-focused")}
		/>
	</div>;

	let selfVisible, pendingUpdate;
	const io = new IntersectionObserver((entries) => {
		selfVisible = entries.at(-1).isIntersecting;
		if (selfVisible && pendingUpdate) {
			pendingUpdate = false;
			requestAnimationFrame(() => {
				refresh();
				report();
			});
		}
	});
	io.observe(el);

	vl = new VirtualList({
		element: scrollEl,
		data: doc.lines,
		itemHeight: LH,
		overscan: LH * 8,
		itemKey: true,
		renderer(line, index) {
			const node = <div className='-line'><span/></div>;
			syncLine(node, line, index);
			return node;
		},
		onReuse: syncLine
	});

	const api = {
		element: el,
		focus,
		blur: () => inputEl.blur(),
		getValue: () => doc.text(),
		getDocument: () => doc,
		setValue,
		setReadOnly,
		isReadOnly: () => readOnly,
		setLanguage,
		getLanguage: () => langId,
		setErrorLine,
		scrollToLine,
		selectAll,
		insertText,
		getSelectedText,
		canUndo: () => history.canUndo,
		canRedo: () => history.canRedo,
		undo,
		redo,
		refresh,
	};

	$cleanup(el, () => {
		clearTimeout(emitTimer);
		clearTimeout(hlTimer);
		cancelHl?.();
		stopDrag?.();
		vl.destroy();
	});

	updateGutterWidth();
	el.classList.toggle("-readonly", readOnly);
	report();
	setLanguage(langId).then(() => {
		paint();
		syncCaret();
		if (autofocus) focus();
		props.onReady?.(api);
	});
	return api;
};
