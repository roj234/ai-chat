import {LRUCache} from "/common/LRUCache.js";
import {testRunner} from "./index.js";

function fail(msg) { console.log("FAIL:", msg); throw new Error(msg); }

/**
 * 校验缓存的内部一致性。onEvict 回调里重入 cache 时，槽位被重复分配过，
 * 就会出现：get() 读到别的 key 的值、size 超过容量、链表成环。
 * @param {LRUCache} cache
 * @param {number} capacity
 * @param {Object} lastSet 影子模型：每个 key 最后一次写入的值
 * @param {string} tag
 */
function validate(cache, capacity, lastSet, tag) {
	const mapKeys = [...Map.prototype.keys.call(cache)];
	const mapSet = new Set(mapKeys);

	if (cache.size !== mapKeys.length)
		fail(`${tag}: size=${cache.size} 但 Map 里实际有 ${mapKeys.length} 个 key`);
	if (cache.size > capacity)
		fail(`${tag}: size=${cache.size} 超过容量 ${capacity}（槽位被重复分配）`);

	// 迭代（最近→最久）必须恰好覆盖 Map 的 key，且链表不能成环
	const iterKeys = [];
	for (const [k] of cache) {
		iterKeys.push(k);
		if (iterKeys.length > capacity + 2) fail(`${tag}: 迭代出现死循环，链表成环`);
	}
	if (iterKeys.length !== mapKeys.length || iterKeys.some(k => !mapSet.has(k)))
		fail(`${tag}: 迭代 [${iterKeys}] 与 Map [${mapKeys}] 不一致`);
	const seen = new Set();
	for (const k of iterKeys) {
		if (seen.has(k)) fail(`${tag}: 迭代里 ${k} 出现了多次`);
		seen.add(k);
	}

	for (const k of Object.keys(lastSet)) {
		const got = cache.get(k);
		if (mapSet.has(k)) {
			if (got !== lastSet[k])
				fail(`${tag}: get(${k}) 返回 ${JSON.stringify(got)}，应该是 ${JSON.stringify(lastSet[k])}（串号）`);
		} else if (got !== undefined) {
			fail(`${tag}: get(${k}) 对已被逐出/删除的 key 返回了 ${JSON.stringify(got)}`);
		}
	}
}

const mulberry32 = a => () => {
	a |= 0; a = a + 0x6D2B79F5 | 0;
	let t = Math.imul(a ^ a >>> 15, 1 | a);
	t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
	return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

testRunner.push(() => {
	const c = new LRUCache(2);
	c.set('a', 1); c.set('b', 2);
	c.set('c', 3);                       // 应逐出 a
	if (c.get('a') !== undefined) fail("a 应已被逐出");
	if (c.get('b') !== 2 || c.get('c') !== 3) fail("b/c 的值不对");
	if (c.size !== 2) fail("size 应为 2");
	c.get('b');                          // b 变最近
	c.set('d', 4);                       // 应逐出 c
	if (c.get('c') !== undefined) fail("c 应已被逐出");
	if (c.get('b') !== 2 || c.get('d') !== 4) fail("b/d 的值不对");
	return true;
}, "LRUCache 基本 LRU 行为");

testRunner.push(() => {
	// 回归：onEvict 里重入 set()。修复前新 key 'X' 会拿到被逐出 key 的槽位，
	// get('X') 返回的是 'c' 的值，且容量 2 的缓存里会塞进 3 个条目。
	const evicted = [];
	let reentered = false;
	const c = new LRUCache(2, {
		onEvict(v, k) {
			evicted.push(`${k}=${v}`);
			if (!reentered) { reentered = true; c.set('X', 'xval'); }
		}
	});
	c.set('a', 1); c.set('b', 2);
	c.set('c', 3);
	if (c.get('X') !== 'xval') fail(`重入后 get('X') = ${JSON.stringify(c.get('X'))}，应为 'xval'`);
	if (c.get('c') !== 3) fail("重入不该破坏 c");
	if (c.get('a') !== undefined || c.get('b') !== undefined) fail("a/b 应都已逐出");
	if (c.size !== 2) fail(`size=${c.size}，容量 2 的缓存不该超过 2 个条目`);
	validate(c, 2, {X: 'xval', c: 3}, "onEvict 重入 set");
	return true;
}, "LRUCache onEvict 回调重入 set 不串号");

testRunner.push(() => {
	// 回归：onEvict 里重入 delete()。修复前外层 delete 会把回调里刚插入的
	// 条目从链表摘掉，并把它的槽位放回空闲链表（该槽位同时仍在 Map 里）。
	let reentered = false;
	const c = new LRUCache(2, {
		onEvict() {
			if (!reentered) { reentered = true; c.set('X', 'xval'); }
		}
	});
	c.set('a', 1); c.set('b', 2);   // 链表：b(头) → a(尾)
	c.delete('a');                  // a 正好是尾，回调里重入 set 会抢到同一个槽位
	if (c.get('X') !== 'xval') fail("重入插入的 X 丢失了");
	if (c.get('a') !== undefined) fail("a 应已删除");
	if (c.get('b') !== 2) fail("b 不该受影响");
	validate(c, 2, {X: 'xval', b: 2}, "onEvict 重入 set(from delete)");

	// 再塞一个，确认空闲链表没有把在用的槽位再分出去。
	// 注意 validate() 内部会调 get()，会改变 LRU 顺序，这里显式把 X 顶成最近使用。
	c.get('X');
	c.set('Y', 'yval');   // 已满，逐出最久未用的 b
	if (c.get('X') !== 'xval') fail("后续 set 之后 X 被串号了");
	if (c.get('Y') !== 'yval') fail("Y 的值不对");
	if (c.get('b') !== undefined) fail("b 应已被逐出");
	validate(c, 2, {X: 'xval', Y: 'yval'}, "重入后继续使用");
	return true;
}, "LRUCache onEvict 回调重入 delete 不破坏空闲链表");

testRunner.push(() => {
	// 回调触发时，被逐出的条目必须已经从索引 / 链表里消失，
	// 否则回调里任何一次读都会拿到马上要被复用的槽位。
	const saw = [];
	const c = new LRUCache(2, {
		onEvict(v, k) { saw.push([k, c.get(k), c.size]); }
	});
	c.set('a', 1); c.set('b', 2);
	c.set('c', 3);
	for (const [k, v, size] of saw) {
		if (v !== undefined) fail(`回调时 get(${k}) 仍能读到 ${JSON.stringify(v)}，槽位尚未复位`);
		if (size > 2) fail(`回调时 size=${size} 超过容量`);
	}
	validate(c, 2, {b: 2, c: 3}, "回调时序");
	return true;
}, "LRUCache onEvict 回调时槽位已复位");

const fuzz = (trials, iters, fixedSeed) => {
	for (let t = 0; t < trials; t++) {
		const seed = fixedSeed ? t * 7919 + 13 : (Date.now() + t) % 100000;
		const rnd = mulberry32(seed);
		const capacity = 1 + (seed % 5);
		const lastSet = {};
		let tag = `seed=${seed} cap=${capacity}`;

		const c = new LRUCache(capacity, {
			onEvict() {
				// 在驱逐回调里随机重入，这是最容易踩坏索引的路径
				const roll = rnd();
				if (roll < 0.45) return;
				const k = 'r' + (rnd() * 6 | 0);
				if (roll < 0.8) { const v = 'rv' + k; lastSet[k] = v; c.set(k, v); }
				else { delete lastSet[k]; c.delete(k); }
				validate(c, capacity, lastSet, tag + " (回调中)");
			}
		});

		for (let i = 0; i < iters; i++) {
			const k = 'k' + (rnd() * 8 | 0);
			const op = rnd();
			// 影子模型必须先于 cache 更新：onEvict 是在 set() 返回之前回调的，
			// 那时新值已经写进缓存，影子还停在旧值会误报串号。
			if (op < 0.62) { const v = 'v' + i; lastSet[k] = v; c.set(k, v); }
			else if (op < 0.82) { delete lastSet[k]; c.delete(k); }
			else { c.get(k); }

			validate(c, capacity, lastSet, `${tag} 第 ${i} 步`);
		}
	}
};

testRunner.push(() => { fuzz(200, 200, true); return true; }, "LRUCache fuzz test static");
testRunner.push(() => { fuzz(100, 200, false); return true; }, "LRUCache fuzz test random");
