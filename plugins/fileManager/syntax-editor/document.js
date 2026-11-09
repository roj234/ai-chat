/**
 * 编辑器文档模型 (行数组实现，简单)
 */

/**
 * @typedef {{line: number, ch: number}} Pos
 * @typedef {{text: string, tokens: ?number[], version: number}} Line
 */

/** @return {Line} */
const makeLine = (text) => ({text, tokens: null, version: 1});

/**
 * @param {string} text
 * @return {Line[]}
 */
const splitLines = (text) => {
	if (!text) return [makeLine("")];
	const parts = text.split("\n");
	const lines = new Array(parts.length);
	for (let i = 0; i < parts.length; i++) lines[i] = makeLine(parts[i]);
	return lines;
};

const pos = (line, ch) => ({line, ch});

const samePos = (a, b) => a.line === b.line && a.ch === b.ch;

/** 在 pos 处插入 text 之后的位置 */
export const advancePos = (p, text) => {
	let lines = 0;
	let lastBreak = -1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) { lines++; lastBreak = i; }
	}
	if (!lines) return {line: p.line, ch: p.ch + text.length};
	return {line: p.line + lines, ch: text.length - lastBreak - 1};
};

export class TextDocument {
	/** @type {Line[]} */
	lines;
	charCount = 0;

	constructor(text = "") {
		this.lines = splitLines(text);
		this.charCount = text.length;
	}

	get lineCount() {
		return this.lines.length;
	}

	/** 全部文本（O(n)，别在每次按键时调用） */
	text() {
		const lines = this.lines;
		const n = lines.length;
		const out = new Array(n);
		for (let i = 0; i < n; i++) out[i] = lines[i].text;
		return out.join("\n");
	}

	lineLength(i) {
		return this.lines[i]?.text.length ?? 0;
	}

	clamp(p) {
		const lines = this.lines;
		let line = p.line;
		if (line < 0) line = 0;
		else if (line >= lines.length) line = lines.length - 1;
		let ch = p.ch;
		const len = lines[line].text.length;
		if (ch < 0) ch = 0;
		else if (ch > len) ch = len;
		return {line, ch};
	}

	/** 取 [a, b) 之间的文本 */
	textInRange(a, b) {
		const lines = this.lines;
		if (a.line === b.line) return lines[a.line].text.slice(a.ch, b.ch);
		const parts = [lines[a.line].text.slice(a.ch)];
		for (let i = a.line + 1; i < b.line; i++) parts.push(lines[i].text);
		parts.push(lines[b.line].text.slice(0, b.ch));
		return parts.join("\n");
	}

	/**
	 * 用 text 替换 [a, b)
	 * @return {{removed: string, index: number, delta: number}}
	 */
	replace(a, b, text) {
		const lines = this.lines;
		const aLine = lines[a.line];
		const bLine = lines[b.line];

		const removed = this.textInRange(a, b);
		const head = aLine.text.slice(0, a.ch);
		const tail = bLine.text.slice(b.ch);

		const parts = text.split("\n");
		const made = new Array(parts.length);
		if (parts.length === 1) {
			made[0] = makeLine(head + text + tail);
		} else {
			made[0] = makeLine(head + parts[0]);
			for (let i = 1; i < parts.length - 1; i++) made[i] = makeLine(parts[i]);
			made[parts.length - 1] = makeLine(parts[parts.length - 1] + tail);
		}

		const del = b.line - a.line + 1;
		const add = made.length;
		const index = a.line;

		if (add <= 2048) {
			lines.splice(index, del, ...made);
		} else {
			// 避免 apply 参数过多
			lines.splice(index, del);
			const len = lines.length;
			lines.length = len + add;
			lines.copyWithin(index + add, index, len);
			for (let i = 0; i < add; i++) lines[index + i] = made[i];
		}

		this.charCount += text.length - removed.length;
		return {removed, index, delta: add - del};
	}

	/** 整体替换（加载文件 / 格式化） */
	setText(text) {
		const lines = this.lines;
		const parts = text.split("\n");
		lines.length = 0;
		for (let i = 0; i < parts.length; i++) lines.push(makeLine(parts[i]));
		this.charCount = text.length;
	}

	/** 全文偏移 -> 行列（校验错误定位用，O(n) 但只在防抖后调用） */
	posFromOffset(offset) {
		const lines = this.lines;
		let acc = 0;
		for (let i = 0; i < lines.length; i++) {
			const len = lines[i].text.length;
			if (acc + len >= offset) return {line: i, ch: offset - acc};
			acc += len + 1;
		}
		const last = lines.length - 1;
		return {line: last, ch: lines[last].text.length};
	}
}

/**
 * 撤销栈：保存「反向补丁」，连续输入会合并成一步
 */
export class History {
	undoStack = [];
	redoStack = [];
	#lastTime = 0;

	get canUndo() {
		return this.undoStack.length > 0;
	}

	get canRedo() {
		return this.redoStack.length > 0;
	}

	clear() {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
	}

	/**
	 * @param {{a: Pos, b: Pos, removed: string, inserted: string, before: {anchor: Pos, head: Pos}, after: {anchor: Pos, head: Pos}}} entry
	 * @param {"type"|"back"|"del"|null} kind
	 */
	push(entry, kind) {
		const now = performance.now();
		const prev = this.undoStack.at(-1);

		if (kind && prev && prev.kind === kind && now - this.#lastTime < 800 && this.#merge(prev, entry, kind)) {
			this.#lastTime = now;
			this.redoStack.length = 0;
			return;
		}

		entry.kind = kind;
		this.undoStack.push(entry);
		if (this.undoStack.length > 300) this.undoStack.shift();
		this.redoStack.length = 0;
		this.#lastTime = now;
	}

	#merge(prev, entry, kind) {
		if (kind === "type") {
			if (!prev.inserted || !entry.inserted) return false;
			if (entry.inserted.indexOf("\n") >= 0) return false;
			if (!samePos(entry.a, advancePos(prev.a, prev.inserted))) return false;
			prev.inserted += entry.inserted;
			prev.after = entry.after;
			return true;
		}
		if (kind === "back") {
			if (prev.inserted || entry.inserted) return false;
			// 前一次删除的起点就是这一次删除的终点
			if (!samePos(entry.b, prev.a)) return false;
			prev.a = entry.a;
			prev.removed = entry.removed + prev.removed;
			prev.before = entry.before;
			return true;
		}
		if (kind === "del") {
			if (prev.inserted || entry.inserted) return false;
			if (!samePos(entry.a, prev.a)) return false;
			prev.removed += entry.removed;
			return true;
		}
		return false;
	}

	undo() {
		return this.undoStack.pop();
	}

	redo() {
		return this.redoStack.pop();
	}

	pushRedo(entry) {
		this.redoStack.push(entry);
	}

	pushUndo(entry) {
		this.undoStack.push(entry);
	}
}
