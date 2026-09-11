import {showToast} from "../components/Toast.js";
import {prettyError} from "./utils.js";
import {NestedMap} from "unconscious/common/NestedMap.js";

export class EventBus {
	/**
	 *
	 * @type {Map<string, Set<Function>>}
	 */
	#events = new NestedMap();

	/**
	 *
	 * @param {string | string[]} event
	 * @param {function(data: Object, evt: string[]): void | Promise<void>} handler
	 */
	on(event, handler) {
		let set = this.#events.get(event);
		if (!set) this.#events.set(event, set = new Set);
		set.add(handler);
	}

	/**
	 *
	 * @param {string | string[]} event
	 * @param {function(data: Object, evt: string[]): void | Promise<void>} handler
	 * @return {Function}
	 */
	onoff(event, handler) {
		this.on(event, handler);
		return () => this.off(event, handler);
	}

	/**
	 *
	 * @param {string | string[]} event
	 * @param {function(data: Object, evt: string[]): void | Promise<void>} handler
	 */
	off(event, handler) {
		const h = this.#events.get(event);
		if (!h) return;
		h.delete(handler);
		if (!h.size) this.#events.delete(event, true);
	}
	/**
	 *
	 * @param {string | string[]} event
	 * @param {boolean} includeDescents
	 */
	delete(event, includeDescents) {
		this.#events.delete(event, includeDescents);
	}
	/**
	 *
	 * @param {string | string[]} event
	 */
	has(event) {
		return this.#events.get(event)?.size;
	}
	/**
	 *
	 * @param {string[]} event
	 * @param {Object} first
	 * @param {Object} [rest]
	 */
	post(event, first, ...rest) {
		const x = [];

		const stack = [...event];
		while (stack.length) {
			let set = this.#events.get(stack);
			if (set) for (const fn of set) {
				try {
					const res = fn.call(null, first, event, ...rest);
					if (res instanceof Promise)
						x.push(res);
					else if (res != null)
						return res;
				} catch (e) {
					console.error(e);
					showToast("事件发送失败\n"+prettyError(e), 'error');
				}
			}

			stack.pop();
		}

		return x.length ? Promise.all(x) : undefined;
	}

	fire(event, data) {
		const promise = this.post(event, data);
		this.delete(event, true);
		return promise;
	}
}
