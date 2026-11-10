import "./Menu.css";
import {auxMainlyTouch} from "../states.js";

/**
 * @typedef {{label: string, icon?: JSX.Element, danger?: boolean, disabled?: boolean, act?: Function} | {sep: true}} MenuItem
 */

let openMenu, scrollContainer_, keyboardHelper;

const closeMenu = () => {
	if (!openMenu) return;
	openMenu.remove();
	openMenu = null;
	document.removeEventListener('mousedown', onMouseDown);
	document.removeEventListener('keydown', onKeyDown);
	scrollContainer_.removeEventListener('scroll', closeMenu);
	scrollContainer_ = null;
	keyboardHelper?.focus();
	keyboardHelper = null;
};

/** @param {MouseEvent} ev */
function onMouseDown(ev) {
	const target = ev.target;
	if (openMenu && (!openMenu.contains(target) || (auxMainlyTouch && openMenu === target))) closeMenu();
}

function onKeyDown(ev) {
	if (ev.key === 'Escape') closeMenu();
}

/**
 * @param {PointerEvent} ev
 * @param {HTMLElement} scrollContainer
 * @param {MenuItem[]} items
 * @param {boolean} [forceMenu]
 */
export function openContextMenu(ev, scrollContainer, items, forceMenu) {
	closeMenu();
	if (!items.length) return;

	keyboardHelper = document.activeElement;
	const el = <div className={"menu"+(forceMenu?" -always":"")} onClick={async ev => {
		const btn = ev.target.closest('button[data-i]');
		if (!btn) return;
		const it = items[+btn.dataset.i];
		try {
			const p = it?.act?.();
			if (p instanceof Promise) {
				btn.textContent = "处理中……";
				btn.disabled = true;
				await p;
			}
		} finally {
			closeMenu();
		}
	}} role="list">
		{items.map((it, i) => it.sep ? <hr/> : (
			<button data-i={i} className={it.danger ? 'danger2' : null} disabled={it.disabled} tabIndex={0}>
				{typeof it.icon === 'string' ? <i className={it.icon}/> : it.icon}
				{it.label}
			</button>
		))}
	</div>;
	document.body.appendChild(el);
	if (ev.button < 0) el.firstElementChild.focus();
	const r = el.getBoundingClientRect();
	el.style.left = Math.min(ev.clientX, innerWidth - r.width - 8) + 'px';
	el.style.top = Math.min(ev.clientY, innerHeight - r.height - 8) + 'px';
	openMenu = el;
	document.addEventListener('mousedown', onMouseDown);
	document.addEventListener('keydown', onKeyDown);
	scrollContainer.addEventListener('scroll', closeMenu);
	scrollContainer_ = scrollContainer;
}