
// ==================== 最小堆 ====================

const siftUp = (heap, i) => {
	const node = heap[i];
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (heap[p].time <= node.time) break;
		heap[i] = heap[p];
		i = p;
	}
	heap[i] = node;
};

const siftDown = (heap, i) => {
	const node = heap[i];
	const size = heap.length;
	const half = size >> 1;
	while (i < half) {
		let child = (i << 1) + 1;
		let right = child + 1;
		if (right < size && heap[right].time < heap[child].time) child = right;
		if (node.time <= heap[child].time) break;
		heap[i] = heap[child];
		i = child;
	}
	heap[i] = node;
};

export class TimerHeap {
	heap = [];

	push(task) {
		const heap = this.heap;
		heap.push(task);
		siftUp(heap, heap.length - 1);
	}

	peek() {
		const heap = this.heap;

		while (heap.length && heap[0].cancelled) {
			this.shift();
		}
		return heap[0];
	}

	shift() {
		const heap = this.heap;
		if (heap.length <= 1) { heap.length = 0; return; }
		heap[0] = heap.pop();
		siftDown(heap, 0);
	}

	init() {
		const heap = this.heap;
		for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(heap, i);
	}

	cancel(handle) {
		const top = this.peek();
		if (top === handle) {
			this.shift();
			return true;
		} else {
			handle.cancelled = true;
		}
	}
}