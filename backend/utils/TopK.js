/**
 * 一个用于维护前 K 个最小元素的集合（基于提供的比较函数）。
 * 内部使用数组和二分查找来高效地维护元素顺序，确保始终保留最小的 K 个元素。
 */
export class TopK {
	/**
	 * @param {number} k - 保留的元素个数
	 * @param {function(a: any, b: any): number} comparator - 比较函数，返回负数表示 a < b，0 表示相等，正数表示 a > b
	 */
	constructor(k, comparator) {
		if (typeof comparator !== 'function') {
			throw new TypeError('comparator must be a function');
		}
		this.elements = new Array(k);
		this.comparator = comparator;
		this._size = 0;
	}

	/** 当前元素个数 */
	get size() {
		return this._size;
	}

	/**
	 * 尝试添加一个元素。如果大于当前集合中最大的元素则忽略。
	 * @param {any} element
	 * @returns {boolean} 是否成功插入
	 */
	add(element) {
		const s = this._size;
		// 如果集合不为空且新元素大于最大元素，直接丢弃
		if (s === this.elements.length && this.comparator(element, this.elements[s - 1]) > 0) return false;
		let pos = this._binarySearch(element);
		if (pos < 0) pos = -pos - 1;
		this._insertAt(pos, element);
		return true;
	}

	/** 清空集合 */
	clear() {
		this.elements.fill(undefined);
		this._size = 0;
	}

	/**
	 * 返回当前所有元素的有序数组（浅拷贝）
	 * @returns {any[]}
	 */
	toArray() {
		return this.elements.slice(0, this._size);
	}

	/**
	 * 迭代器，便于 for...of 遍历
	 */
	[Symbol.iterator]() {
		let index = 0;
		return {
			next: () => {
				if (index < this._size) {
					return { value: this.elements[index++], done: false };
				}
				return { done: true };
			}
		};
	}

	// -------- 内部方法 --------

	_binarySearch(target) {
		const arr = this.elements;
		const size = this._size;
		let low = 0;
		let high = size - 1;
		const cmp = this.comparator;

		while (low <= high) {
			const mid = (low + high) >>> 1;
			const result = cmp(target, arr[mid]);
			if (result < 0) {
				high = mid - 1;
			} else if (result > 0) {
				low = mid + 1;
			} else {
				return mid; // 找到精确匹配
			}
		}
		// 未找到，返回 -插入点 - 1
		return -(low + 1);
	}

	_insertAt(index, element) {
		const arr = this.elements;
		const s = this._size;
		if (index < s) {
			let moveCount = s - index;
			// 如果已满，移动时会把最后一个元素挤出数组（但仍保留在内存中，但不再被 size 引用）
			if (s === arr.length) {
				moveCount--;
			}
			for (let i = s - 1; i >= index; i--) {
				if (i + 1 < arr.length) {
					arr[i + 1] = arr[i];
				}
			}
		}
		arr[index] = element;
		if (this._size < arr.length) {
			this._size++;
		}
	}
}