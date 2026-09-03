import {clearTimeout as ct, setTimeout as st} from "./heap-timer.js";

export const TYPE_EVICT = 1;
export const TYPE_REMOVE = 2;

const IS_NODE = !import.meta.env?.MODE;
const setTimeout1 = IS_NODE ? setTimeout : st;
const clearTimeout1 = IS_NODE ? clearTimeout : ct;

/**
 * @template K
 * @template V
 * @extends Map<K, number>
 */
export class LRUCache extends Map {
	/** @type {K[]} */
	#keys;
	/** @type {V[]} */
	#values;
	/** @type {Uint8Array} */
	#prev;
	/** @type {Uint8Array} */
	#next;
	/** @type {number} */
	#head;
	/** @type {number} */
	#tail;
	/** @type {number} */
	#freeList;
	/** @type {number} */
	#NULL;

	/** @type {Array | Uint32Array} */
	#ttlTimer;
	/** @type {Uint32Array} */
	#ttl;
	/** @type {Array} */
	#ttlClosure;
	#ttlMode;

	/** @type {function(V, K, TYPE_EVICT | TYPE_REMOVE): void} */
	#onEvict;

	/**
	 * @param {number} capacity
	 * @param {Object | Function} [options]
	 * @param {(value: V, key: K, reason: TYPE_EVICT | TYPE_REMOVE) => void} [options.onEvict] 驱逐回调
	 * @param {ArrayConstructor | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor} [options.keyType]
	 * @param {ArrayConstructor | Int8ArrayConstructor | Uint8ArrayConstructor | Int16ArrayConstructor | Uint16ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor} [options.valueType]
	 * @param {'update' | 'access' | 'livetime'} [options.ttlMode]
	 */
	constructor(capacity, options) {
		if (!Number.isSafeInteger(capacity)) throw new TypeError('容量必须是整数');
		if (capacity <= 0 || capacity >= 65535) throw new RangeError("容量太小或太大，超过 uint16 范围");

		super();

		if (typeof options === 'function') options = { onEvict: options };
		const { onEvict, keyType = Array, valueType = Array, ttlMode } = options ?? {};

		const IndexType = capacity <= 255 ? Uint8Array : Uint16Array;

		this.#keys = new keyType(capacity);
		this.#values = new valueType(capacity);
		this.#prev = new IndexType(capacity);
		this.#next = new IndexType(capacity);

		this.#NULL = capacity;
		this.#onEvict = onEvict;

		if (ttlMode) {
			this.#ttlTimer = IS_NODE ? Array(capacity) : new Uint32Array(capacity);
			this.#ttlClosure = Array(capacity);
			this.#ttlMode = ttlMode;
			if (ttlMode === 'access') {
				if (!IS_NODE) this.#ttl = new Uint32Array(capacity);

				// 在这里定义可以无分支，代价只是体积稍大
				Object.defineProperty(this, 'get', {
					value: (key) => {
						const idx = super.get(key);
						if (idx === undefined) return;

						const timers = this.#ttlTimer;
						if (timers[idx]) {
							if (IS_NODE) {
								const timer = timers[idx];
								timer.refresh();
								timer.unref();
							} else {
								clearTimeout1(timers[idx]);
								timers[idx] = setTimeout1(this.#ttlClosure[idx], this.#ttl[idx]);
							}
						}

						this.#moveToFront(idx);
						return this.#values[idx];
					}
				});
			} else if (ttlMode === 'livetime') {
				/*Object.defineProperty(this, 'get', {
					value: (key) => {
						const idx = super.get(key);
						if (idx === undefined) return;

						this.#ttl[idx] = Date.now();

						this.#moveToFront(idx);
						return this.#values[idx];
					}
				});*/
			}
		}

		// 初始化时全部空闲
		this.clear();
	}

	// ---------- Map 接口 ----------

	get capacity() {
		return this.#NULL;
	}

	clear() {
		if (this.#onEvict) {
			for (const idx of super.values()) {
				this.#onEvict(this.#values[idx], this.#keys[idx], TYPE_REMOVE);
			}
		}

		super.clear();

		this.#keys.fill(undefined);
		this.#values.fill(undefined);

		const capacity = this.#NULL;
		this.#head = this.#tail = capacity;

		this.#freeList = 0;
		for (let i = 0; i < capacity; i++) this.#next[i] = i + 1;
		this.#next[capacity - 1] = capacity;
	}

	/**
	 * @param {K} key
	 * @return {V | undefined}
	 */
	get(key) {
		const idx = super.get(key);
		if (idx === undefined) return;

		this.#moveToFront(idx);
		return this.#values[idx];
	}

	//has(key) {return super.has(key);}
	//get size() {return super.size;}

	/**
	 *
	 * @param {K} key
	 * @param {V} value
	 * @param {number} [ttlMs]
	 * @return {LRUCache<K, V>}
	 */
	set(key, value, ttlMs) {
		const timers = this.#ttlTimer;

		let idx = super.get(key);
		if (idx !== undefined) {
			if (timers) this.#initTTL(timers, idx, ttlMs);
			this.#values[idx] = value;
			this.#moveToFront(idx);
			return this;
		}

		idx = this.#freeList;
		if (idx === this.#NULL) {
			idx = this.#tail;
			this.#remove(idx);

			const k = this.#keys[idx];
			super.delete(k);

			this.#onEvict?.(k, this.#values[idx], TYPE_EVICT);
		} else {
			this.#freeList = this.#next[idx];
		}

		if (timers) this.#initTTL(timers, idx, ttlMs);

		this.#keys[idx] = key;
		this.#values[idx] = value;
		super.set(key, idx);
		this.#insert(idx);
		return this;
	}

	#initTTL(timers, idx, ttlMs) {
		clearTimeout1(timers[idx]);
		if (ttlMs != null) {
			const closure = this.#ttlClosure;
			const timer = timers[idx] = setTimeout1(closure[idx] ?? (closure[idx] = this.delete.bind(this, this.#keys[idx])), ttlMs);
			if (IS_NODE) timer.unref();
		} else {
			timers[idx] = 0;
		}

		const timeouts = this.#ttl;
		if (timeouts) timeouts[idx] = ttlMs;
	}

	/**
	 * @param {K} key
	 * @return {boolean}
	 */
	delete(key) {
		let idx = super.get(key);
		if (idx === undefined) return false;

		super.delete(key);

		this.#onEvict?.(key, this.#values[idx], TYPE_REMOVE);

		const timers = this.#ttlTimer;
		if (timers?.[idx]) {
			clearTimeout1(timers[idx]);
			timers[idx] = 0;
			this.#ttlClosure[idx] = undefined;
		}

		this.#remove(idx);

		this.#next[idx] = this.#freeList;
		this.#freeList = idx;
		this.#prev[idx] = this.#NULL;
		this.#keys[idx] = undefined;
		this.#values[idx] = undefined;

		return true;
	}

	#insert(idx) {
		this.#prev[idx] = this.#NULL;
		this.#next[idx] = this.#head;
		if (this.#head !== this.#NULL) this.#prev[this.#head] = idx;
		else this.#tail = idx;
		this.#head = idx;
	}

	#remove(idx) {
		const p = this.#prev[idx];
		const n = this.#next[idx];
		if (p !== this.#NULL) this.#next[p] = n;
		else this.#head = n;
		if (n !== this.#NULL) this.#prev[n] = p;
		else this.#tail = p;
	}

	#moveToFront(idx) {
		if (this.#head === idx) return;
		this.#remove(idx);
		this.#insert(idx);
	}

	// ---------- 迭代（最近 → 最久） ----------

	forEach(callbackfn, thisArg) {
		let idx = this.#head;
		while (idx !== this.#NULL) {
			const next = this.#next[idx];
			callbackfn.call(thisArg, this.#values[idx], this.#keys[idx], this);
			idx = next;
		}
	}

	/**
	 * @return {IterableIterator<[K, V]>}
	 */
	*entries() {
		let idx = this.#head;
		while (idx !== this.#NULL) {
			const next = this.#next[idx];
			yield [this.#keys[idx], this.#values[idx]];
			idx = next;
		}
	}

	/**
	 * @return {IterableIterator<K>}
	 */
	*keys() {
		let idx = this.#head;
		while (idx !== this.#NULL) {
			const next = this.#next[idx];
			yield this.#keys[idx];
			idx = next;
		}
	}

	/**
	 * @return {IterableIterator<V>}
	 */
	*values() {
		let idx = this.#head;
		while (idx !== this.#NULL) {
			const next = this.#next[idx];
			yield this.#values[idx];
			idx = next;
		}
	}

	[Symbol.iterator]() {
		return this.entries();
	}

	[Symbol.toStringTag]() {
		return "LRUCache";
	}
}
