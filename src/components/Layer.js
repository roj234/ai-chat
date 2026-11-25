import './Layer.css';
import Filter from "unconscious/common/components/Filter.jsx";
import {$state} from "unconscious";
import {smartButtonKeyHandler} from "../utils/utils.js";
import {auxKeyboardOnly, auxMainlyTouch} from "../states.js";

const modalStack = [document.body];

// region 模态弹窗
/**
 * 打开一个模态弹窗
 * @param {'info' | 'input' | 'filter'} type
 * @param {string} title
 * @param {string} className
 * @param {string} message
 * @param {string} placeholder
 * @param {string} value
 * @param {string} list datalist 元素的 id
 * @param {'primary' | 'danger' | 'ghost'} accent
 * @param {string} confirmMessage
 * @param {string} cancelMessage
 * @param {function(string): void = } onConfirm
 * @param {function(string, any, Record<string, any>): void = } onFilterChanged
 * @param {function(string): void = } onCancel
 * @param {Element} after
 * @returns {HTMLDivElement}
 */
export const openModal = ({
		type = 'info', // 'info' or 'input'
		title = '提示',
		className = '',
		message,
		placeholder,
		value,
		list,
		accent = 'primary',
		confirmMessage = '确认',
		cancelMessage = '取消',
		onConfirm,
		onFilterChanged,
		onCancel,
		after
}) => {
	let inputValue = '';
	const ignoreCancel = onCancel === null;

	const removeDOM = () => {
		origRemove();

		const i = modalStack.lastIndexOf(modal);
		if (i === modalStack.length - 1) {
			modalStack.pop();
			const toasts = toastStacks.pop();
			const prevToasts = toastStacks.at(-1);
			toasts.childNodes.forEach(el => prevToasts.append(el));
		} else {
			modalStack.splice(i, 1);
			toastStacks.splice(i, 1);
		}
	};

	const handleClose = async () => {
		if (ignoreCancel || false === await onCancel?.(inputValue)) return;
		removeDOM();
	}

	const handleConfirm = async () => {
		if (false === await onConfirm?.(inputValue)) return;
		removeDOM();
	};

	let input;
	const onFocusBlur = e => {
		const isFocus = e.type === "focus";
		input.style.height = isFocus ? "500px" : "";
	};

	let filter;
	if (type === "filter") {
		inputValue = $state(placeholder || {});
		const onChanged = () => queueMicrotask(() => {
			modal.querySelector(".btn.primary").disabled = !!filter.hasError();
		});
		filter = <Filter config={value} choices={inputValue} onChange={(k, v, obj) => {
			onChanged();
			onFilterChanged?.(k, v, obj);
		}} />;
		onChanged();
	} else {
		inputValue = value;
	}

	let downPos;
	const modal = <dialog className={"modal " + className} onPointerDown={(e) => {
		downPos = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
	}} onClick={(e) => {
		if (e.pointerId < 0 || (downPos != null && e.pointerId != null && e.pointerId !== downPos.pointerId) || !modal.isConnected) return;

		// 检测点击是否落在 dialog 自身（而非内部子元素）
		const rect = modal.getBoundingClientRect();
		const inside = (x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

		if (!inside(downPos.x, downPos.y) && !inside(e.clientX, e.clientY) && onConfirm && !ignoreCancel) handleClose();
	}}>
		<div className="-head"><b>{title}</b></div>
		<div className="-body">
			{typeof message === 'string' ? <p>{message}</p> : message}
			{type === 'input' ? <input className={"text-input"}
				onInput={(e) => inputValue = e.target.value}
				placeholder={placeholder} list={list}
				onKeyDown={(e) => {
					e.key === "Enter" && handleConfirm();
				}}
				value={value}
			/> :
			type === 'textarea' ? input = <textarea className={"text-input"}
				onInput={(e) => inputValue = e.target.value}
				onFocus={onFocusBlur} onBlur={onFocusBlur}
				placeholder={placeholder}
			>{value}</textarea> : null}
			{filter}
			{after}
		</div>
		{smartButtonKeyHandler(<div className="-butt">
			<button className={"btn " + accent} onClick={onConfirm ? handleConfirm : handleClose}>{confirmMessage}</button>
			{onConfirm && !ignoreCancel && <button className="btn ghost" onClick={handleClose}>{cancelMessage}</button>}
		</div>)}
	</dialog>;

	modal.addEventListener('cancel', (e) => {
		if (e.target !== modal) return;
		e.preventDefault();
		handleClose();
	});

	const origRemove = modal.remove.bind(modal);
	modal.remove = removeDOM;

	document.body.append(modal);
	modal.showModal();

	modalStack.push(modal);
	toastStacks.push(<div className='toasts fix' />);

	return modal;
};
// endregion
// region 右键菜单
/**
 * @typedef {{label: string, icon?: JSX.Element, danger?: boolean, disabled?: boolean, act?: Function, el?: HTMLElement} | {sep: true}} MenuItem
 */

/** @type {HTMLElement} */
let currentMenu, scrollContainer_, prevFocus;

/** @param {MouseEvent} ev */
const onMouseDown = ev => {
	const target = ev.target;
	if (currentMenu && (!currentMenu.contains(target) || (auxMainlyTouch && currentMenu === target))) closeMenu();
};

const onKeyDown = ev => {
	if (ev.key === 'Escape') closeMenu();
};

export const closeMenu = () => {
	if (!currentMenu) return;
	currentMenu.remove();
	currentMenu = null;
	document.removeEventListener('mousedown', onMouseDown);
	document.removeEventListener('keydown', onKeyDown);
	scrollContainer_.removeEventListener('scroll', closeMenu);
	scrollContainer_ = null;
	prevFocus?.focus();
	prevFocus = null;
};

/**
 * @param {PointerEvent} ev
 * @param {HTMLElement} scrollContainer
 * @param {MenuItem[]} items
 * @param {boolean} [maybeShelve]
 */
export function openMenu(ev, scrollContainer, items, maybeShelve) {
	closeMenu();
	if (!items.length) return;

	prevFocus = document.activeElement;
	const el = <div className={"menu"+(!maybeShelve?" -always":"")} onClick.stop={async ev => {
		const btn = ev.target.closest('button[data-i]');
		if (!btn) return;
		const it = items[+btn.dataset.i];
		try {
			const p = it?.act?.(ev);
			if (p instanceof Promise) {
				btn.textContent = "处理中……";
				btn.disabled = true;
				await p;
			}
		} finally {
			closeMenu();
		}
	}} role="list">
		{items.map((it, i) => it.sep ? <hr/> : it.el ?? (
			it.act ?
			<button data-i={i} className={it.danger ? 'danger2' : null} disabled={it.disabled} tabIndex={0}>
				{typeof it.icon === 'string' ? <i className={it.icon}/> : it.icon}
				{it.label}
			</button>
				:
			<span>
				{typeof it.icon === 'string' ? <i className={it.icon}/> : it.icon}
				{it.label}
			</span>
		))}
	</div>;
	smartButtonKeyHandler(el);
	modalStack.at(-1).appendChild(el);
	if (ev.button < 0) el.firstElementChild.focus();
	const r = el.getBoundingClientRect();
	let x = ev.clientX;
	let y = ev.clientY;
	if (!x && !y) {
		const rect = ev.target.getBoundingClientRect();
		x = rect.left + rect.width / 2;
		y = rect.top + rect.height / 2;
	}
	el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
	el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
	currentMenu = el;
	document.addEventListener('mousedown', onMouseDown);
	document.addEventListener('keydown', onKeyDown);
	scrollContainer.addEventListener('scroll', closeMenu);
	scrollContainer_ = scrollContainer;
}
// endregion
// region 提示条
let toastStacks = [<div className="toasts"/>];

/**
 * @template T
 * @param {import("unconscious").Renderable} message
 * @param [type='' | 'error' | 'ok']
 * @param {number} [timeout]
 * @param {function(closedBy: Event | T | undefined): void} [onClose]
 * @param {import("unconscious").Renderable} [closeBtn]
 * @param {HTMLDivElement} dom
 * @return {function(T?): void}
 */
export const showToast = (message, type, timeout = 5000, {onClose, closeBtn, dom} = {}) => {
	if (!dom) {
		const last = toastStacks.at(-1);
		if (!last.isConnected) modalStack.at(-1).append(last);
		dom = last;
	}

	const closeToast = (event) => {
		onClose?.(event);
		timer?.cancel();
		el.classList.add("-closing");
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

	dom.append(el);
	return closeToast;
};

class PausableTimer {
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
// endregion

export const closeTopLayer = () => {
	if (currentMenu) {
		closeMenu();
		return true;
	}

	const element = document.elementFromPoint(0, 0);
	if (element.matches("dialog.modal")) {
		element.dispatchEvent(new Event('cancel'));
		return true;
	}
	return false;
};