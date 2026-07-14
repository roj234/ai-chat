
/**
 * Myers diff O((M+N)*D) — same algorithm used by git
 * @param {string[]} a
 * @param {string[]} b
 * @param {boolean} strip
 * @returns {{ type: 'same' | 'add' | 'del', oldIndex: number | null, newIndex: number | null, text: string }[]}
 */
export function textDiff(a, b, strip) {
	const m = a.length, n = b.length;

	// Trim common prefix and suffix (free wins)
	let prefix = 0;
	while (prefix < m && prefix < n && a[prefix] === b[prefix]) prefix++;

	let suffix = 0;
	while (suffix < m - prefix && suffix < n - prefix &&
	a[m - 1 - suffix] === b[n - 1 - suffix]) suffix++;

	const aMid = a.slice(prefix, m - suffix);
	const bMid = b.slice(prefix, n - suffix);

	const midOps = myers(aMid, bMid);

	const ops = [];

	// prefix: all same
	if (!strip) for (let i = 0; i < prefix; i++) {
		ops.push({ type: 'same', oldIdx: i, newIdx: i, text: a[i] });
	}

	// middle: diff result (adjust indices)
	for (const op of midOps) {
		ops.push({
			type: op.type,
			oldIdx: op.oldIdx != null ? op.oldIdx + prefix : null,
			newIdx: op.newIdx != null ? op.newIdx + prefix : null,
			text: op.text
		});
	}

	// suffix: all same
	if (strip) for (let i = 0; i < suffix; i++) {
		const oi = m - suffix + i;
		const ni = n - suffix + i;
		ops.push({ type: 'same', oldIdx: oi, newIdx: ni, text: a[oi] });
	}

	return ops;
}

function myers(a, b) {
	const m = a.length, n = b.length;
	if (m === 0 && n === 0) return [];
	if (m === 0) return b.map((t, i) => ({ type: 'add', oldIdx: null, newIdx: i, text: t }));
	if (n === 0) return a.map((t, i) => ({ type: 'del', oldIdx: i, newIdx: null, text: t }));

	const max = m + n;
	const V = new Int32Array(2 * max + 1);
	const trace = [];        // trace[d] = copy of V after depth d

	V[max + 1] = 0;

	for (let d = 0; d <= max; d++) {
		for (let k = -d; k <= d; k += 2) {
			const idx = max + k;
			let x;

			if (k === -d || (k !== d && V[idx - 1] < V[idx + 1])) {
				x = V[idx + 1];        // down (from k+1)
			} else {
				x = V[idx - 1] + 1;    // right (from k-1)
			}
			let y = x - k;

			while (x < m && y < n && a[x] === b[y]) { x++; y++; }

			V[idx] = x;

			if (x >= m && y >= n) {
				trace.push(new Int32Array(V));
				return backtrack(trace, a, b, m, n, d);
			}
		}
		trace.push(new Int32Array(V));
	}
	return [];
}

function backtrack(trace, a, b, m, n, endD) {
	const ops = [];
	let x = m, y = n;

	for (let d = endD; d >= 0; d--) {
		const V = trace[d];
		const k = x - y;
		const idx = (V.length - 1) / 2 + k;

		let prevK;
		if (k === -d || (k !== d && V[idx - 1] < V[idx + 1])) {
			prevK = k + 1;  // came from down
		} else {
			prevK = k - 1;  // came from right
		}

		const prevIdx = (V.length - 1) / 2 + prevK;
		const prevX = d > 0 ? trace[d - 1][prevIdx] : 0;
		const prevY = prevX - prevK;

		// emit matching lines (the diagonal part of the snake)
		while (x > prevX && y > prevY) {
			x--; y--;
			ops.unshift({ type: 'same', oldIdx: x, newIdx: y, text: a[x] });
		}

		if (d > 0) {
			if (x > prevX) {
				// horizontal step: delete a[x-1]
				x--;
				ops.unshift({ type: 'del', oldIdx: x, newIdx: null, text: a[x] });
			} else {
				// vertical step: insert b[y-1]
				y--;
				ops.unshift({ type: 'add', oldIdx: null, newIdx: y, text: b[y] });
			}
		}
	}

	return ops;
}
