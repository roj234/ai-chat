import "./ImageViewer.css";
import {debugSymbol} from "@roj234/shared";
import {openMenu} from "/src/components/Layer.js";
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {$cleanup, $state} from "unconscious";
import {vfsDownloadMultiple} from "./downloader.js";
import {callFileSystemFunc, FS_SOURCE, resolveVirtualUrl, vfsIdentity} from "../agent/index.js";
import {downloadFile, prettyError} from "/src/utils/utils.js";
import {formatSize} from "unconscious/common/Utils.js";
import {config} from "/src/states.js";

const ITEM_STATE = debugSymbol('ImageLocation');
const DEFAULT_STATE = [0, 0, null, 0];
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 20;
const ZOOM_STEP = 1.35;
const ANIM_MS = 220;
const smooth = { behavior: 'smooth' };

export const createImageViewer = (title) => {
	let fs;
	let supportThumb;
	let images = [];
	let img, stage;

	let index = 0;
	let x = 0;
	let y = 0;
	let scale = 1;
	let rotate = 0;
	let fitScale = 1; // 适应窗口时 自然尺寸 -> 屏幕尺寸 的比例
	let fitMode = true; // 当前是否处于「适应窗口」状态，窗口尺寸变化时跟随重算

	let pointers = new Map();
	let mode = null;
	let drag = null;
	let pinch = null;

	let _rafResize = 0;

	let _thumbsEl, _zoomLabel;

	const endPointer = (e) => {
		if (!pointers.delete(e.pointerId)) return;
		syncPointers();
	};

	let pixelated;

	const contextMenu = e => {
		e.preventDefault();
		openMenu(e, dom, [
			{ icon: "ri-download-line", label: "下载", act: download },
			{ icon: pixelated ? "ri-checkbox-line" : "ri-checkbox-blank-line", label: "邻近插值缩放 (像素)", act: () => pixelated = dom.classList.toggle('-pixelated') },
		], true);
	};

	const download = () => {
		const item = images[index];
		if (!item) return;
		if (fs) vfsDownloadMultiple(fs, [item]);
		else downloadFile(item.url, '图片');
	};

	const dom = <div className="ImageViewer">
		<div className="-stage" ref={stage} onPointerDown={(e) => {
			if (e.pointerType === 'mouse' && e.button !== 0) return;
			if (pointers.size >= 2) return;
			stage.setPointerCapture(e.pointerId);
			pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
			syncPointers();
		}} onPointerMove={(e) => {
			const p = pointers.get(e.pointerId);
			if (!p) return;
			p.x = e.clientX;
			p.y = e.clientY;

			if (pointers.size >= 2) {
				handlePinch();
			} else if (mode === 'drag' && drag) {
				x = drag.panX + (e.clientX - drag.x);
				y = drag.panY + (e.clientY - drag.y);
				onChange(false);
			}
		}} onPointerCancel={endPointer} onPointerUp={endPointer}
			 onWheel.noPassive={(e) => {
				 e.preventDefault();
				 let d = e.deltaY;
				 if (e.deltaMode === 1) d *= 16;
				 else if (e.deltaMode === 2) d *= 400;
				 const factor = Math.exp(-d * 0.0018);
				 zoomAt(e.clientX, e.clientY, scale * factor, false);
			 }} onDblClick={(e) => {
			e.preventDefault();
			if (scale > fitScale * 1.02) fitView();
			else zoomAt(e.clientX, e.clientY, fitScale * 2.5, true);
		}} onContextMenu={contextMenu} />

		<button className="btn ri-arrow-left-s-line" style="left:18px" title="上一张" onClick={() => go(index - 1)}/>
		<button className="btn ri-arrow-right-s-line" style="right:18px" title="下一张" onClick={() => go(index + 1)}/>

		<div className="-bar">
			<div className="-thumbs" ref={_thumbsEl} onClick={e => {
				const btn = e.target.closest('.-thumb');
				if (!btn) return;
				go(Number(btn.dataset.index));
			}} />
			<div className="-tools">
				<button className="btn ghost" onClick={() => zoomBy(1 / ZOOM_STEP)}>
					<span className="tooltip">缩小</span>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
						 stroke-linecap="round">
						<circle cx="10.5" cy="10.5" r="6.5"/>
						<path d="M6.5 10.5h8M20 20l-4.2-4.2"/>
					</svg>
				</button>
				<button className="btn ghost -zoom" title="缩放比例" ref={_zoomLabel} onClick={() => {
					if (Math.abs(scale - 1) < 1e-3) {
						fitView();
					} else {
					 	actualSize();
					}
				}}>100%</button>
				<button className="btn ghost" onClick={() => zoomBy(ZOOM_STEP)}>
					<span className="tooltip">放大</span>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
						 stroke-linecap="round">
						<circle cx="10.5" cy="10.5" r="6.5"/>
						<path d="M6.5 10.5h8M10.5 6.5v8M20 20l-4.2-4.2"/>
					</svg>
				</button>
				<span className="-sep"></span>
				<button className="btn ghost" onClick={() => rotateBy()}>
					<span className="tooltip">旋转</span>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
						 stroke-linejoin="round">
						<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/>
						<path d="M20.5 3.5v5.2h-5.2"/>
					</svg>
				</button>
				{/*<button className="btn ghost" onClick={() => download()}>
					<span className="tooltip">另存为</span>
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
						 stroke-linejoin="round">
						<path d="M12 3.5v11.5"/>
						<path d="M7.5 10.5L12 15l4.5-4.5"/>
						<path d="M4.5 20.5h15"/>
					</svg>
				</button>*/}
				<button className="btn ghost" title="更多" onClick={contextMenu}>
					<svg viewBox="0 0 24 24" fill="currentColor">
						<circle cx="5" cy="12" r="1.7"/>
						<circle cx="12" cy="12" r="1.7"/>
						<circle cx="19" cy="12" r="1.7"/>
					</svg>
				</button>
			</div>
		</div>
	</div>;

	let loading;

	/**
	 * @param {number} i
	 */
	const go = async (i) => {
		if (loading) return;
		loading = true;

		const prev = images[index];
		if (prev) prev[ITEM_STATE] = [x, y, fitMode ? null : scale, rotate];

		const n = images.length;
		index = ((i % n) + n) % n;
		const item = images[index];

		[x, y, scale, rotate] = item[ITEM_STATE] || DEFAULT_STATE;
		fitMode = scale == null;

		stage.replaceChildren(<div className="-image spinner" />);

		img = <img className="-image" alt={item.name} />;
		let blob, size;

		try {
			if (fs) {
				let path = item.path;
				const url = resolveVirtualUrl(fs, path);
				if (url) img.src = url;
				else {
					blob = await callFileSystemFunc(fs, 'readRaw', {path});
					img.src = blob.toUrl();
					size = blob.size;
				}
			} else {
				const url = item.url;
				if (typeof url === 'string') {
					img.src = url;
				} else {
					blob = url;
					img.alt ||= blob.name;
					img.src = blob.toUrl();
					size = blob.size;
				}
			}

			await img.decode();
		} catch (e) {
			img.alt += '\n'+prettyError(e);
		} finally {
			title.value = img.alt+` (${img.naturalWidth}x${img.naturalHeight}像素${size ? `, ${formatSize(img.size)}` : ''}) - Aint看图王 - 第${i+1}/${images.length}张`;
			loading = false;
			blob?.revokeUrl();

			fitScale = computeFitScale();
			if (fitMode) scale = fitScale;

			onChange(false);
			stage.replaceChildren(img);

			onChange();
			updateActiveThumb();
		}
	}

	const onChange = (animate = false) => {
		img.style.transition = animate
			? `transform ${ANIM_MS}ms cubic-bezier(.22,.8,.3,1)`
			: 'none';
		img.style.transform =
			`translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0) ` +
			`scale(${scale}) rotate(${rotate}deg)`;

		_zoomLabel.textContent = Math.round(scale * 100) + '%';
	}

	const computeFitScale = () => {
		const iw = img.naturalWidth;
		const ih = img.naturalHeight;
		if (!iw || !ih) return 1;
		const rect = stage.getBoundingClientRect();
		if (!rect.width || !rect.height) return 1;
		return Math.min(rect.width / iw, rect.height / ih);
	}

	const clampScale = (s) => {
		const max = Math.max(ZOOM_MAX * fitScale, 2);
		const min = Math.min(ZOOM_MIN * fitScale, ZOOM_MIN);
		return Math.min(max, Math.max(min, s));
	}

	/* ---------- 缩放 ---------- */
	const zoomAt = (clientX, clientY, targetScale, animate = true) => {
		const rect = stage.getBoundingClientRect();
		const next = clampScale(targetScale);
		if (Math.abs(next - scale) < 1e-6) return;

		// 以指针为锚点
		const ax = clientX - rect.left - rect.width / 2;
		const ay = clientY - rect.top - rect.height / 2;
		const k = next / scale;

		x = ax - (ax - x) * k;
		y = ay - (ay - y) * k;
		scale = next;
		fitMode = false;

		onChange(animate);
	}

	const zoomBy = (factor) => {
		const rect = stage.getBoundingClientRect();
		zoomAt(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
			scale * factor,
			true
		);
	}

	const fitView = () => {
		fitMode = true;
		scale = fitScale || 1;
		x = 0;
		y = 0;
		onChange(true);
	}

	const actualSize = () => {
		const rect = stage.getBoundingClientRect();
		zoomAt(
			rect.left + rect.width / 2,
			rect.top + rect.height / 2,
			1,
			true
		);
	}

	const rotateBy = (deg = 90) => {
		rotate += deg;
		onChange(true);
	}

	const syncPointers = () => {
		const n = pointers.size;

		if (n === 0) {
			mode = null;
			drag = null;
			pinch = null;
			stage.classList.remove('-moving');
			return;
		}

		if (n === 1) {
			const p = [...pointers.values()][0];
			mode = 'drag';
			pinch = null;
			drag = { x: p.x, y: p.y, panX: x, panY: y };
			stage.classList.add('-moving');
			return;
		}

		// 双指
		const [a, b] = [...pointers.values()];
		const rect = stage.getBoundingClientRect();
		mode = 'pinch';
		drag = null;
		pinch = {
			dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
			scale: scale,
			panX: x,
			panY: y,
			midX: (a.x + b.x) / 2,
			midY: (a.y + b.y) / 2,
			left: rect.left,
			top: rect.top,
			w: rect.width,
			h: rect.height,
		};
		stage.classList.remove('-moving');
	}

	const handlePinch = () => {
		const pts = [...pointers.values()];
		if (pts.length < 2 || !pinch) return;

		const [a, b] = pts;
		const p = pinch;
		const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
		const midX = (a.x + b.x) / 2;
		const midY = (a.y + b.y) / 2;

		const next = clampScale(p.scale * (dist / p.dist));
		const k = next / p.scale;

		const sax = p.midX - p.left - p.w / 2;
		const say = p.midY - p.top - p.h / 2;

		x = sax - (sax - p.panX) * k + (midX - p.midX);
		y = say - (say - p.panY) * k + (midY - p.midY);
		scale = next;
		fitMode = false;

		onChange(false);
	}

	/* ---------- 键盘 ---------- */
	const onKeyDown = (e) => {
		if (e.altKey || e.ctrlKey || e.metaKey) return;

		switch (e.key) {
			default: return;

			case 'ArrowLeft':case 'PageUp': go(index - 1); break;
			case 'ArrowRight':case 'PageDown': go(index + 1); break;
			case '+':case '=':zoomBy(ZOOM_STEP);break;
			case '-':case '_':zoomBy(1 / ZOOM_STEP);break;
			case 'Escape':case '0':fitView();break;
			case '1':actualSize();break;
			case 'r':case 'R':rotateBy(90);break;
		}

		e.preventDefault();
	};

	const onResize = () => {
		cancelAnimationFrame(_rafResize);
		_rafResize = requestAnimationFrame(() => {
			if (!images.length) return;

			fitScale = computeFitScale();
			if (fitMode) {
				scale = fitScale;
				x = 0;
				y = 0;
				onChange(false);
			}
		});
	};

	const updateActiveThumb = () => {
		const prevActive = _thumbsEl.querySelector('.active');
		const nextActive = vl.getValue(index);
		if (prevActive === nextActive) return;

		if (prevActive) prevActive.classList.remove('active');
		if (nextActive) {
			nextActive.classList.add('active');
			nextActive.scrollIntoView(smooth);
		} else {
			vl.scrollIntoView(index - 2, smooth);
		}
	};

	const vl = new VirtualList({
		horizontal: true,
		itemHeight: 86,
		gap: 8,
		renderer: (item, i) => <button className={"-thumb"+(index === i ? ' active' : '')} data-index={i}>
			{supportThumb ? createThumbImage(fs, item) : item.name}
		</button>,
		element: _thumbsEl,
	});

	const setImages = (newFs, newImages, forcedIndex) => {
		loading = false;

		const newIndex = forcedIndex ?? ((!fs || vfsIdentity(fs[FS_SOURCE]) !== vfsIdentity(newFs[FS_SOURCE])) ? -1 : newImages.indexOf(images[index]));

		const callback = (ok) => {
			supportThumb = ok;
			images = newImages;
			fs = newFs;
			dom.classList.toggle('-single', newImages.length <= 1);
			vl.setItems(newImages);
			if (newIndex >= 0) queueMacrotask(updateActiveThumb);

			return go(Math.max(newIndex, 0));
		};
		if (!newFs) return callback(false);

		return checkThumbAbility(newFs).then(callback);
	};

	const ro = new ResizeObserver(onResize);
	ro.observe(dom);
	$cleanup(dom, () => ro.disconnect());

	return {
		element: dom,
		onFocus(focused) {
			if (focused) document.addEventListener('keydown', onKeyDown);
			else document.removeEventListener('keydown', onKeyDown);
		},
		setImages
	};
}

const THUMB = debugSymbol("ThumbAvail");
export const checkThumbAbility = async fs => config.pv_thumbnail && (fs[THUMB] ??= await callFileSystemFunc(fs, 'thumb', {path:""}).then(res => res.size === 0, () => false));

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {FileEntry} item
 * @param {number} [sizeClass]
 */
export const createThumbImage = (fs, item, sizeClass) => {
	const state = $state();
	const key = '_thumb'+(sizeClass||'');
	const blobCallback = blob => {
		const value = <img src={blob.toUrl()} alt={item.name} loading='lazy' />;
		$cleanup(value, () => blob.revokeUrl());
		state.value = value;
		item[key] = blob;
	};

	const cached = item[key];
	if (cached) {
		blobCallback(cached);
	} else {
		state.value = <span className="spinner" />;
		callFileSystemFunc(fs, 'thumb', {path: item.path, size: sizeClass}).then(blobCallback, () => {
			state.value = item.name;
		});
	}

	return state;
}