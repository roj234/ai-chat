/**
 * 简单的 LRU 缓存
 */
export class LRUCache {
	#map = new Map();
	#max;
	#onEvict;

	/**
	 * @param {number} [maxEntries=500]
	 * @param {(key: any, value: any) => void} [onEvict] 驱逐回调
	 */
	constructor(maxEntries = 500, onEvict) {
		this.#max = maxEntries;
		this.#onEvict = onEvict;
	}

	/**
	 * 获取缓存值，未命中/过期返回 undefined。
	 * 命中时会移到末尾（LRU 维护）。
	 */
	get(key) {
		const entry = this.#map.get(key);
		if (!entry) return;

		if (Date.now() >= entry.expireAt) {
			this.#map.delete(key);
			return;
		}

		// 刷新 LRU 顺序
		this.#map.delete(key);
		this.#map.set(key, entry);
		return entry.value;
	}

	/**
	 * 写入缓存。
	 * @param {number} ttlMs TTL 毫秒数，0 表示永不过期
	 */
	set(key, value, ttlMs) {
		this.#map.delete(key);
		if (this.#map.size >= this.#max) {
			const oldest = this.#map.keys().next().value;
			const evicted = this.#map.get(oldest);
			this.#map.delete(oldest);
			if (evicted) this.#onEvict?.(oldest, evicted.value);
		}

		this.#map.set(key, {
			value,
			expireAt: ttlMs > 0 ? Date.now() + ttlMs : Infinity,
		});
	}

	/** 缓存条目数 */
	get size() { return this.#map.size; }

	/** 清空缓存 */
	clear() {
		if (this.#onEvict) {
			for (const [key, entry] of this.#map) {
				this.#onEvict(key, entry.value);
			}
		}
		this.#map.clear();
	}

	/** 手动删除并触发驱逐回调 */
	delete(key) {
		const entry = this.#map.get(key);
		if (entry) {
			this.#map.delete(key);
			this.#onEvict?.(key, entry.value);
			return true;
		}
		return false;
	}
}