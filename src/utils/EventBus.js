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
	 */
	off(event, handler) {
		this.#events.get(event)?.delete(handler);
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
	 * @param {Object} data
	 */
	post(event, data) {
		const x = [];

		const initEvent = [...event];
		while (event.length) {
			let set = this.#events.get(event);
			if (set) for (const fn of set) {
				try {
					const res = fn(data, initEvent);
					if (res instanceof Promise)
						x.push(res);
				} catch (e) {
					showToast("事件发送失败\n"+prettyError(e), 'error');
				}
			}

			event.pop();
		}

		return Promise.all(x);
	}
}
