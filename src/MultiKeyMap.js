import {debugSymbol} from "unconscious";

const DATA_VAL = debugSymbol('DataValue');

/**
 * MultiKeyMap - 支持数组作为复合键的 Map
 */
export class MultiKeyMap {
	constructor(entries = []) {
		this._tree = new Map();
		this._simple = new Map();
		this._size = 0;

		for (const [keys, value] of entries) {
			this.set(keys, value);
		}
	}

	/**
	 * 设置值
	 * @param {any|any[]} keys
	 * @param {any} value
	 */
	set(keys, value) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				let current = this._tree;
				for (const key of keys) {
					let next = current.get(key);
					if (!next) {
						current.set(key, next = new Map());
					}
					current = next;
				}

				if (!current.has(DATA_VAL)) this._size++;
				current.set(DATA_VAL, value);
				return this;
			}

			keys = keys[0];
		}
		this._simple.set(keys, value);
		return this;
	}

	/**
	 * 获取值
	 * @param {any|any[]} keys
	 */
	get(keys) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				let current = this._tree;
				for (const key of keys) {
					current = current.get(key);
					if (!current) return;
				}
				return current.get(DATA_VAL);
			}

			keys = keys[0];
		}

		return this._simple.get(keys);
	}

	/**
	 * 判断是否存在
	 * @param {any|any[]} keys
	 */
	has(keys) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				let current = this._tree;
				for (const key of keys) {
					current = current.get(key);
					if (!current) return false;
				}
				return current.has(DATA_VAL);
			}

			keys = keys[0];
		}

		return this._simple.has(keys);

	}

	/**
	 * 删除键值对
	 * @param {any|any[]} keys
	 */
	delete(keys) {
		if (Array.isArray(keys)) {
			if (keys.length > 1) {
				const stack = []; // 用于后续清理空节点
				let current = this._tree;

				for (const key of keys) {
					stack.push({ parent: current, key });
					current = current.get(key);
					if (!current) return false;
				}

				if (!current.delete(DATA_VAL)) return false;
				this._size--;

				// 递归向上删除不再需要的 Map 节点（瘦身）
				for (let i = stack.length - 1; i >= 0; i--) {
					const { parent, key } = stack[i];
					const node = parent.get(key);
					if (node.size > 0) break;
					parent.delete(key);
				}

				return true;
			}

			keys = keys[0];
		}

		return this._simple.delete(keys);

	}

	get size() {
		return this._size + this._simple.size;
	}

	/**
	 * 迭代器实现 (DFS)
	 */
	*[Symbol.iterator]() {
		// TODO 可选2, 不过目前使用场景只要能迭代就行
		/*for (const [key, value] of this._simple.entries()) {
			yield [[key], value]
		}*/
		yield* this._simple[Symbol.iterator]();
		yield* this._traverse(this._tree, []);
	}

	*_traverse(map, path) {
		if (map.has(DATA_VAL)) {
			// TODO 可选 [...path] 复制对象
			yield [path, map.get(DATA_VAL)];
		}

		for (const [key, nextMap] of map.entries()) {
			if (key !== DATA_VAL) {
				path.push(key);
				yield* this._traverse(nextMap, path);
				path.pop();
			}
		}
	}

	clear() {
		this._tree.clear();
		this._size = 0;
	}
}