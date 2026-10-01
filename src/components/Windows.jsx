import "./Windows.css";

import {$computed, $foreach, $state, $update, $watchWithCleanup, appendChild} from 'unconscious';
import {auxSmallScreen, EVENT_BUS} from "../states.js";

/**
 * @typedef {Object} WindowState
 * @property {string} id
 * @property {HTMLElement} element
 * @property {boolean} resizable
 * @property {boolean} minimized
 * @property {boolean} active
 * @property {JSX.Element} icon
 * @property {JSX.Element} title
 */

const MINIMIZED = "minimized";
const MAXIMIZED = 'maximized';

/** 当前已打开的窗口：id -> state */
const windows = new Map();

/** 响应式窗口列表，供任务栏监听 */
const windowList = $state([]);
let focusedWindow;

/** 自增的 z-index 基准 */
let topZ = 1000;

const syncList = () => { windowList.value = [...windows.values()]; };

const isWindowOpen = (id) => windows.has(id);

export const getWindow = (id) => windows.get(id);

/** 由 FloatingWindow 在创建好 DOM 后调用，注册到管理器 */
const registerWindow = (id, state) => {
	windows.set(id, state);
	syncList();
};

/**
 * 把指定窗口置顶并获得焦点。若活动窗口未变化则不触发任务栏重渲染。
 * @param {WindowState | string} w
 */
export const focusWindow = (w) => {
	if (typeof w === 'string') w = windows.get(w);
	if (!w || focusedWindow === w) return;

	w.element.style.zIndex = ++topZ;
	focusedWindow = w;
	$update(windowList);
};

function syncFocused(w) {
	if (focusedWindow === w) {
		let top = null, topZ = -Infinity;
		for (const win of windows.values()) {
			if (win.element.classList.contains(MINIMIZED)) continue;
			const z = +win.element.style.zIndex || 0;
			if (z > topZ) {
				topZ = z;
				top = win;
			}
		}
		if (top) focusWindow(top);
	}
}

const TRANSITION = 'closing';
/**
 * 关闭窗口。
 * @param {WindowState | string} w
 */
export const closeWindow = (w) => {
	if (typeof w === 'string') w = windows.get(w);
	if (!w) return;

	const el = w.element;
	el.classList.add(TRANSITION);
	const end = () => el.remove(w.reuse);
	el.addEventListener('animationend', end);
	setTimeout(end, 160);

	windows.delete(w.id);
	EVENT_BUS.post(['closeWindow', w.id], w);
	syncList();
	syncFocused(w);
};

/**
 * 最小化窗口。
 * @param {WindowState} w
 */
const minimizeWindow = (w) => {
	const el = w.element;
	const classList = el.classList;
	if (!classList.contains(MINIMIZED)) {
		classList.add(MINIMIZED, TRANSITION);

		const end = () => {
			if (!classList.contains(MINIMIZED)) return;

			el.removeEventListener('animationend', end);
			classList.remove(TRANSITION);
			$update(windowList);
			syncFocused(w);
		};
		el.addEventListener('animationend', end);
		setTimeout(end, 160);
	}
};

/**
 * 从最小化状态还原并置顶。
 * @param {WindowState} w
 */
const restoreWindow = (w) => {
	const classList = w.element.classList;
	if (classList.contains(MINIMIZED)) {
		classList.remove(MINIMIZED, TRANSITION);
		$update(windowList);
	}
	focusWindow(w);
};

/**
 * 切换最大化（仅 resizable 窗口可用）。
 * @param {WindowState} w
 */
const toggleMaximize = (w) => {
	if (!w?.resizable) return;
	$update(windowList);
	return w.element.classList.toggle(MAXIMIZED);
};

const cloneContent = (node) => typeof node === "function" ? $computed(node) : node.cloneNode?.(true) || node;
const extractText = (node) => node.textContent || node;

const MIN_W = 280;
const MIN_H = 200;
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

/**
 * 打开一个浮动窗口。
 *
 * @param {Object} config
 * @param {JSX.Element} [config.icon] - 图标
 * @param {JSX.Element} [config.title] - 标题
 * @param {JSX.Element} [config.actions] - 标题栏扩展
 * @param {JSX.Element | function(WindowState): JSX.Element} config.element - 内容
 * @param {number} config.width
 * @param {number} config.height
 * @param {boolean} [config.resizable=true] - 是否允许缩放与最大化
 * @returns {WindowState}
 */
export const openWindow = ({
	id, icon, title,
	actions,
	element,
	width = 1024, height = 768,
	dock,
	resizable = true,
	reuse,
}) => {
	mountTaskbar();

	const w = getWindow(id);
	if (w) { restoreWindow(w); return w; }

	if (icon == null) {
		icon = title[0];
		title = title.slice(1);
	}

	/** @type {WindowState} */
	const state = {
		id, icon, title, resizable, reuse,
		active: true,
		element: null,
	};

	let maxBtn;

	const handleMaximize = () => {
		if (!state.resizable) return;
		const maximized = toggleMaximize(state);
		maxBtn.className = (maximized ? 'ri-fullscreen-exit-line' : 'ri-fullscreen-line')+" ghost";
	};

	const startDrag = (e) => {
		const classList = root.classList;
		if (classList.contains(MAXIMIZED)) {
			classList.remove(MAXIMIZED);

			maxBtn.className = 'ri-fullscreen-line ghost';

			const wpx = root.offsetWidth;
			root.style.left = clamp(e.clientX - wpx / 2, 0, innerWidth - wpx) + 'px';
			root.style.top = '0';
		}

		const baseLeft = parseFloat(root.style.left) || 0;
		const baseTop = parseFloat(root.style.top) || 0;
		const startX = e.clientX, startY = e.clientY;

		classList.add('dragging');

		const onMove = (ev) => {
			// 保证标题留在视口内
			const nx = clamp(baseLeft + (ev.clientX - startX), -root.offsetWidth + 80, innerWidth - 80);
			const ny = clamp(baseTop + (ev.clientY - startY), 0, innerHeight - 35);
			root.style.left = nx + 'px';
			root.style.top = ny + 'px';
		};
		const onUp = () => {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			classList.remove('dragging');
		};
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		e.preventDefault();
	};

	const startResize = (e) => {
		const baseW = root.offsetWidth;
		const baseH = root.offsetHeight;
		const startX = e.clientX, startY = e.clientY;

		root.classList.add('resizing');

		const onMove = (ev) => {
			const nw = clamp(baseW + (ev.clientX - startX), MIN_W, innerWidth);
			const nh = clamp(baseH + (ev.clientY - startY), MIN_H, innerHeight);
			root.style.width = nw + 'px';
			root.style.height = nh + 'px';
		};
		const onUp = () => {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			root.classList.remove('resizing');
		};
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		e.preventDefault(); // 防止触发 selection 行为
	};

	const count = windowList.length || 0;
	const offset = (count % 6) * 28;

	const iw = innerWidth, ih = innerHeight;

	if (width <= 1) width = iw * width;
	else if (width > iw) width = iw;

	if (height <= 1) height = ih * height;
	else if (height > ih) height = ih;

	if (typeof element === "function") element = element(state);

	let top, left;
	if (dock) {
		top = 0;
		left = dock === 'right' ? innerWidth - width : 0;
		height = ih;
	} else {
		left = clamp((iw - width) / 2 + offset, 0, iw - 120);
		top = clamp((ih - height) / 2 + offset, 0, ih - 120);
	}

	const root = (
		<div className="window"
			 style={`left:${left}px;top:${top}px;width:${width}px;height:${height}px;`}
			 onPointerDown={() => focusWindow(state)}>
			<div className="win-header">
				<span className="icon">{cloneContent(icon)}</span>
				<span className="title" onPointerDown.left={startDrag} onDblclick={handleMaximize}>{cloneContent(title)}</span>
				<span className="controls">
					{actions}
					<button className="ri-subtract-line ghost" title="最小化" onClick={() => minimizeWindow(state)}></button>
					{resizable && <button ref={maxBtn} className="ri-fullscreen-line ghost" title="最大化" onClick={handleMaximize}></button>}
					<button className="ri-close-line" title="关闭" onClick={() => closeWindow(state)}></button>
				</span>
			</div>
			<div className={"win-body "+id}>{element}</div>
			{resizable && <div className="win-resize" onPointerDown.left={startResize}></div>}
		</div>
	);

	state.element = root;
	registerWindow(id, state);
	EVENT_BUS.post(['openWindow', id], state);
	focusWindow(state);
	if (auxSmallScreen) handleMaximize();
	document.body.append(root);
	return state;
};

let mounted = false;

const Taskbar = () => {
	$watchWithCleanup(windowList, () => {
		document.body.classList.toggle('taskbar-open', windowList.length > 0);
	});

	return (
		<aside className="taskbar">
			{$foreach(windowList, w => {
				return <div
					className={'item' + (w.element.className.slice(6)) + (w === focusedWindow ? ' active' : '')}
					onClick={() => {
						if (w.element.classList.contains(MINIMIZED)) restoreWindow(w);
						else if (w === focusedWindow) minimizeWindow(w);
						else focusWindow(w);
					}}>
					<span className="icon">{cloneContent(w.icon)}</span>
					<span className="label">{cloneContent(w.title)}</span>
					<button className="ri-close-line" title="关闭" onClick.stop={() => closeWindow(w.id)}></button>
				</div>
			}, w => w, {
				morphChild(w, node) {
					node.className = 'item' + (w.element.className.slice(6)) + (w === focusedWindow ? ' active' : '');
				}
			})}
		</aside>
	);
};

/** 挂载任务栏 */
const mountTaskbar = () => {
	if (mounted) return;
	mounted = true;
	appendChild(document.body, <Taskbar/>);
};