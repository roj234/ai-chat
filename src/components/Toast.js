import './Toast.css';
import {auxKeyboardOnly} from "../states.js";

export class PausableTimer {
	#callback;
	#remaining;
	#timerId;
	#startTime;
	#isPaused = true;

	/**
	 * @param {Function} callback
	 * @param {number} delay
	 */
	constructor(callback, delay) {
		this.#callback = callback;
		this.#remaining = delay;
		this.resume();
	}

	pause() {
		if (this.#isPaused || this.#isPaused === 0) return;
		this.#isPaused = true;
		clearTimeout(this.#timerId);
		// 计算本次运行了多久，从剩余时间里扣减
		this.#remaining -= Date.now() - this.#startTime;
	}

	resume() {
		if (!this.#isPaused) return;
		this.#isPaused = false;
		this.#startTime = Date.now();
		// 使用剩余时间继续倒数
		this.#timerId = setTimeout(this.#callback, this.#remaining);
	}

	cancel() {
		clearTimeout(this.#timerId);
		this.#isPaused = 0;
	}
}

let container;

/**
 * @template T
 * @param {import("unconscious").Renderable} message
 * @param [type='' | 'error' | 'ok']
 * @param {number} [timeout]
 * @param {function(closedBy: Event | T | undefined): void} [onClose]
 * @param {import("unconscious").Renderable} [closeBtn]
 * @return {function(T?): void}
 */
export const showToast = (message, type, timeout = 5000, {onClose, closeBtn} = {}) => {
	if (!container) document.body.append(container = <div className="toasts" />);

	const closeToast = (event) => {
		onClose?.(event);
		timer?.cancel();
		el.classList.add("closing");
		setTimeout(() => el.remove(), 600);
	};

	let timer;
	const content = typeof message === "string" ? <span>{message}</span> : message;
	const close = closeBtn ?? (timeout >= 0 ? <button className="close" onClick={closeToast}>&times;</button> : null);
	let el;

	if (timeout > 0) {
		if (auxKeyboardOnly) timeout *= 100;

		timer = new PausableTimer(closeToast, timeout);

		el = <div className={"toast "+(type||'info')} onMouseEnter={() => timer.pause()} onMouseLeave={() => timer.resume()}>
			{content}
			{close}
			<div className="timer" style={`animation-duration: ${timeout}ms`}></div>
		</div>;
	} else {
		el = <div className={"toast "+(type||'info')}>
			{content}
			{close}
		</div>;
	}

	container.append(el);
	return closeToast;
};
