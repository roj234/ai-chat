import {getTextContent} from "/src/utils/utils.js";

const BitSet = size => new Uint32Array((size + 31) >>> 5);

const setBit = (mask, index) => {
	mask[index >>> 5] |= 1 << (index & 31);
};

const hasBit = (mask, index) => (
	mask[index >>> 5] &
	(1 << (index & 31))
) !== 0;

const regexpEscape = literal => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {number} dividend
 * @param {number} divisor
 * @return {number}
 */
const positiveMod = (dividend, divisor) => {
	const remainder = dividend % divisor;
	return remainder >= 0 ? remainder : (remainder + divisor) % divisor;
};

export class LorebookMatcher {
	/** @type {Uint16Array} */
	#constant;
	/** @type {{
	 * order: number,
	 * page: AiChat.DnD.MyLorebookPage,
	 * pattern?: RegExp,
	 * adjacency?: Uint16Array
	 }[]} */
	#pages;
	/** @type {number} */
	#recursiveStart;
	/** @type {number} */
	#matchEnd;
	/** @type {number} */
	#maxWindow;

	/** @type {Uint16Array} */
	#inputState;
	/** @type {Uint32Array[]} */
	#history = [];
	/** @type {number} */
	#historyPos = 0;
	/** @type {Uint32Array} */
	#freeHistorySet;
	/** @type {Uint32Array} */
	#recursiveState;

	/** @type {Map<number, Uint16Array>} */
	#recursive = new Map;
	/** @type {Uint16ArrayConstructor} */
	#array;

	/** @type {string[]} */
	#oldInput = [];
	/** @type {Set<number>} */
	#activePages;
	/** @type {AiChat.DnD.MyLorebookPage[]} */
	#sortedActivePages;

	/**
	 * @param {AiChat.DnD.MyLorebookPage[]} pages
	 */
	constructor(pages) {
		const constant = [];
		const byInput = new Set;
		const byRecursion = new Set;
		let maxWindow = 1;

		for (let i = 0; i < pages.length; i++) {
			const page = pages[i];
			if (!page.enabled) continue;
			if (page.constant) { constant.push(i); continue; }

			const recursion = page.recursion;
			if (
				recursion &&
				recursion !== true &&
				recursion !== "only" &&
				recursion !== "stop"
			) {
				throw new TypeError(`pages[${i}].recursion 必须是 true、falsy、"only" 或 "stop"`);
			}

			if (recursion !== "only") {
				byInput.add(i);
				const window = page.window;

				if (window > maxWindow) maxWindow = window;
			}
			if (recursion) byRecursion.add(i);
		}

		let inputOnly = [], inputAndRecursion = [];
		for (let p of byInput) {
			if (!byRecursion.delete(p)) inputOnly.push(p);
			else inputAndRecursion.push(p);
		}

		const indices = [...inputOnly, ...inputAndRecursion, ...byRecursion];
		const sortedPages = indices.map(pageIndex => {
			const page = pages[pageIndex];
			const triggers = page.triggers;
			if (!triggers?.length) throw new TypeError("非constant的页面必须具有trigger");
			return {
				order: pageIndex,
				page,
				pattern: new RegExp((page.regex ? triggers : triggers.map(regexpEscape)).join("|"), 'miu'),
			}
		});

		const findArrayConstructor = (size) => {
			if (size < 256) return Uint8Array;
			if (size < 65536) return Uint16Array;
			return Uint32Array;
		};

		const init = new (findArrayConstructor(indices.length+constant.length))(constant.length);
		constant.forEach((order, index) => {
			init[index] = sortedPages.length;
			sortedPages.push({order, page: pages[order]});
		});

		this.#array = findArrayConstructor(indices.length);
		this.#pages = sortedPages;
		this.#constant = init;
		this.#recursiveStart = inputOnly.length;
		this.#matchEnd = inputOnly.length + inputAndRecursion.length;
		this.#inputState = new (findArrayConstructor(maxWindow))(sortedPages.length);
		this.#recursiveState = new (findArrayConstructor(this.#matchEnd))(sortedPages.length);
		this.#activePages = new Set(init);
		this.#maxWindow = maxWindow;
	}

	#findAdjacency(page) {
		const adj = [];

		if (page.recursion !== 'stop') {
			const text = page.content;
			const pages = this.#pages;
			const end = pages.length - this.#constant.length;
			for (let j = this.#recursiveStart; j < end; j++) {
				const pattern = pages[j].pattern;
				pattern.lastIndex = 0;
				if (pattern.test(text)) adj.push(j);
			}
		}

		return adj.length ? new this.#array(adj) : null;
	}

	/**
	 *
	 * @param {number} start
	 * @return {Uint16Array}
	 */
	#findDescents(start) {
		const caches = this.#recursive;
		const cached = caches.get(start);
		if (cached) return cached;

		const visited = new Set;
		let curr = [start], next = new Set;

		do {
			for (const idx of curr) {
				visited.add(idx);

				const page = this.#pages[idx];
				let adj = page.adjacency;
				if (adj === undefined) adj = page.adjacency = this.#findAdjacency(page.page);
				if (adj) adj.forEach(idx => !visited.has(idx) && next.add(idx));
			}

			curr = [...next];
			next.clear()
		} while (curr.length);

		visited.delete(start);

		const output = new this.#array(visited);
		caches.set(start, output);
		if (caches.size > 500) caches.delete(caches.keys().next().value);
		return output;
	}

	/**
	 * @param {AiChat.Message[]} input
	 * @return {AiChat.DnD.MyLorebookPage[]}
	 */
	match(input) {
		const oldInput = this.#oldInput;
		const history = this.#history;
		const state = this.#inputState;
		const recursiveState = this.#recursiveState;

		let i = 0;
		for (; i < oldInput.length; i++) {
			// reset
			if (null == input[i] || oldInput[i] !== getTextContent(input[i])) {
				this.#activePages = new Set(this.#constant);
				this.#historyPos = 0;
				this.#sortedActivePages = undefined;
				history.length = 0;
				state.fill(0);
				recursiveState.fill(0);
				oldInput.length = 0;
				i = 0;
				break;
			}
		}

		const pages = this.#pages;
		const pageLen = this.#matchEnd;
		const cur = this.#activePages;
		const inputLen = input.length;
		const maxWindow = this.#maxWindow;
		let curChanged;

		for (; i < inputLen; i++) {
			const content = getTextContent(input[i]);
			oldInput.push(content);

			const historyPos = this.#historyPos % maxWindow;
			const changed = new Set;

			let activationMask = this.#freeHistorySet;
			if (activationMask) activationMask.fill(0);
			else activationMask = BitSet(pageLen);

			for (let j = 0; j < pageLen; j++) {
				const page = pages[j];
				const pattern = page.pattern;
				const window = page.page.window;

				// 没有window的Page永久激活，不再增加delta
				if (!window && state[j]) continue;

				pattern.lastIndex = 0;

				let delta = 0;

				if (pattern.test(content)) {
					setBit(activationMask, j);
					delta++;
				}

				if (window) {
					const retired = history[positiveMod(historyPos - window, maxWindow)];
					if (retired && hasBit(retired, j)) delta--;
				}

				if (delta) {
					const oldState = state[j];
					const newState = oldState + delta;
					state[j] = newState;
					changed.add(j);

					// 其中一个为零
					if (!oldState || !newState) {
						const descents = this.#findDescents(j);
						for (const child of descents) {
							recursiveState[child] += delta;
							changed.add(child);
						}
					}
				}
			}

			this.#historyPos = historyPos + 1;
			this.#freeHistorySet = history[historyPos];
			history[historyPos] = activationMask;

			for (const idx of changed) {
				if (state[idx] | recursiveState[idx]) {
					if (!cur.has(idx)) {
						curChanged = true;
						cur.add(idx);
					}
				} else {
					curChanged |= cur.delete(idx);
				}
			}
		}

		const sorted = this.#sortedActivePages;
		if (!curChanged && sorted) return sorted;
		return this.#sortedActivePages = [...cur].sort((a, b) => pages[a].order - pages[b].order).map(i => pages[i].page);
	}
}
