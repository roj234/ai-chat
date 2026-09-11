import {clearTimeout as ct, setTimeout as st} from "./heap-timer.js";
import {immutableObjectMap} from "unconscious/common/Utils.js";

export const TYPE_EVICT = 1;
export const TYPE_REMOVE = 2;

const IS_NODE = !import.meta.env?.MODE;
const setTimeout1 = IS_NODE ? setTimeout : st;
const clearTimeout1 = IS_NODE ? clearTimeout : ct;
const MODES = immutableObjectMap({
	'access': 1,
	'update': 2,
	'livetime': 3
})

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

	/** @type {Object[]} */
	#ttlTimer;
	/** @type {number} */
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
		if (capacity <= 0 || capacity > 65535) throw new RangeError("容量太小或太大，超过 uint16 范围");

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

		const intMode = MODES[ttlMode];
		if (intMode) {
			this.#ttlTimer = Array(capacity);
			this.#ttlMode = intMode;
		} else if (ttlMode) {
			throw new TypeError("Invalid ttlMode, should be "+Object.keys(MODES));
		}

		// 初始化时全部空闲
		this.#clear();
	}

	// ---------- Map 接口 ----------

	get capacity() {
		return this.#NULL;
	}

	clear() {this.#clear(true);}
	#clear(cancelTimers) {
		if (this.#onEvict) {
			for (const idx of super.values()) {
				this.#onEvict(this.#values[idx], this.#keys[idx], TYPE_REMOVE);
			}
		}

		const timers = this.#ttlTimer;
		if (timers && cancelTimers) {
			for (let i = 0; i < timers.length; i++) {
				clearTimeout1(timers[i]);
			}
			timers.fill(undefined);
		}

		super.clear();

		this.#keys.fill(undefined);
		this.#values.fill(undefined);

		const capacity = this.#NULL;
		this.#head = this.#tail = capacity;

		this.#freeList = 0;
		for (let i = 0; i < capacity; i++) this.#next[i] = i + 1;
	}

	/**
	 * @param {K} key
	 * @return {V | undefined}
	 */
	get(key) {
		const idx = super.get(key);
		if (idx === undefined) return;

		if (this.#ttlMode === 1) {
			const timers = this.#ttlTimer;
			const timer = timers[idx];
			if (timer) {
				if (IS_NODE) {
					timer.refresh();
					timer.unref();
				} else {
					clearTimeout1(timer);
					timers[idx] = setTimeout1(timer.fn, timer.delay);
				}
			}
		}

		this.#moveToFront(idx);
		return this.#values[idx];
	}

	/**
	 *
	 * @param {K} key
	 * @param {V} value
	 * @param {number} [ttlMs]
	 * @return {LRUCache<K, V>}
	 */
	set(key, value, ttlMs) {
		const ttlMode = this.#ttlMode;

		let idx = super.get(key);
		if (idx !== undefined) {
			const old = this.#values[idx];
			this.#values[idx] = value;
			this.#moveToFront(idx);

			if (ttlMode && (ttlMode !== 3 || (value !== old)))
				this.setTTL(idx, ttlMs);
			return this;
		}

		idx = this.#freeList;
		if (idx === this.#NULL) {
			idx = this.#tail;

			const k = this.#keys[idx];
			this.#onEvict?.(this.#values[idx], k, TYPE_EVICT);

			this.#remove(idx);
			super.delete(k);
		} else {
			this.#freeList = this.#next[idx];
		}

		this.#keys[idx] = key;
		this.#values[idx] = value;
		super.set(key, idx);
		this.#insert(idx);

		if (ttlMode) this.setTTL(idx, ttlMs);
		return this;
	}

	setTTL(idx, ttlMs) {
		const timers = this.#ttlTimer;
		const timer = timers[idx];
		if (timer) {
			clearTimeout1(timer);
			timers[idx] = undefined;
		}

		if (ttlMs) {
			const callback = this.delete.bind(this, this.#keys[idx]);
			const timer = timers[idx] = setTimeout1(callback, ttlMs);
			if (IS_NODE) timer.unref();
		}
	}

	/**
	 * @param {K} key
	 * @return {boolean}
	 */
	delete(key) {
		let idx = super.get(key);
		if (idx === undefined) return false;

		this.#onEvict?.(this.#values[idx], key, TYPE_REMOVE);

		super.delete(key);

		const timers = this.#ttlTimer;
		if (timers?.[idx]) {
			clearTimeout1(timers[idx]);
			timers[idx] = undefined;
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
}
Object.defineProperty(LRUCache, Symbol.toStringTag, { value: "LRUCache" });
