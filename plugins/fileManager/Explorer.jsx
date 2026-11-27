import {openWindow} from "/src/components/Windows.jsx";

import "./Explorer.css";
import {
	$asyncState,
	$cleanup,
	$computed,
	$foreach,
	$state,
	$unwatch,
	$update,
	$vforeach,
	$watch,
	unconscious
} from "unconscious";
import {auxMainlyTouch, auxSmallScreen, EVENT_BUS, selectedConversation} from "/src/states.js";
import {callFileSystemFunc, createFileSystem, FS_SOURCE, vfsIdentity} from "../agent/index.js";
import {IMAGE_EXT, vfsPreview, vfsPreviewImage} from "./preview.js";
import {openMenu, openModal, showToast} from "/src/components/Layer.js";
import {AS_IS, ONCE_EVENT, ref} from "@roj234/shared";
import {Icon_search, Icon_warning} from "/src/components/Icons.jsx";
import {formatDate, formatSize} from "unconscious/common/Utils.js";
import {normalizePath} from "@roj234/shared/path";
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";
import {iconClassOf, iconColorOf} from "./fileTypes.js";
import {copyWithAnimation, prettyError} from "/src/utils/utils.js";
import {openTerminal} from "./Terminal.jsx";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {webviewUploadImage} from "/vendor/jsBridge.js";
import {openRecorder} from "../voiceInput/Recorder.jsx";
import {vfsDownloadMultiple} from "./downloader.js";
import {vfsCopyMove} from "../agent/Mounts.js";
import {createAsyncQueue} from "/common/pure-utils.js";
import {xhrUpload} from "./uploader.js";
import {grepCard} from "../agent/GrepCard.jsx";
import {escapeHtmlText, escapeRegexp} from "@roj234/shared/strings";
import {parseGlobPattern} from "../../common/fs-glob.js";
import {mdiToast} from "./MDIToast.js";
import {checkThumbAbility, createThumbImage} from "./ImageViewer.jsx";

/* ============================== 工具函数 ============================== */
const GLOB_META_CHARS = /[\\*?[{]/g;

/**
 * 目录项
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {'file' | 'dir'} type
 * @property {number} size
 * @property {number} mtime
 * @property {string} path
 * @property {HTMLInputElement?} [edit]
 */

const joinPath = (a, b) => !a ? b : (b ? a + '/' + b : a);
const baseName = p => p.slice(p.lastIndexOf('/')+1);
const parentOf = p => {
	const i = p.lastIndexOf('/');
	return i < 0 ? '' : p.slice(0, i);
};
const extOf = n => {
	const i = n.lastIndexOf('.');
	return i > 0 ? n.slice(i + 1).toLowerCase() : '';
};
const isDirectory = a => a.type !== 'file';

/* ============================== 图标 ============================== */

const iconFolder2 = () => <div className="icon ri-folder-fill" style="background:linear-gradient(135deg,#4f8cff,#a371f7);background-clip:text;-webkit-text-fill-color:transparent;-webkit-background-clip:text;" />;

/* ============================== 入口 ============================== */

/**
 * 现在 FileBrowserInterface 也算"真的存在"了
 * @param {AiChat.FileSystemInstance} [fs]
 * @param {string} [path]
 * @param {string | Set<string>} [highlight]
 * @return {Promise<import("/src/components/Windows.jsx").WindowState>}
 */
export const openFileBrowser = async (fs, path = '', highlight) => {
	fs ??= await createFileSystem(unconscious(selectedConversation));

	const fsId = vfsIdentity(fs[FS_SOURCE]);
	const cwd = $state("文件管理");
	const browser = openWindow({
		id: "preview "+encodeURI(fsId),
		title: $computed(() => fsId + (unconscious(cwd) || '')),
		icon: iconFolder2(),
		element: (state) => {
			const el = createExplorerWidget(fs, cwd);
			state.navigateTo = el.navigateTo;
			return el;
		},
	});
	await browser.navigateTo(path, highlight);
	return browser;
};

/* ============================== 界面 ============================== */

/**
 * 全局（跨窗口）剪贴板
 * @type {import("unconscious").Reactive<{ fs: AiChat.FileSystemInstance, cut: boolean, items: FileEntry[] } | null>}
 */
const clipboard = $state(null);

/** 处于「剪切」状态的路径，用于行高亮 */
const cutPaths = $computed(() => (
	new Set(clipboard.cut ? clipboard.items.map(it => it.path) : [])
));
$watch(cutPaths, () => {});

function openGrepDialog(fs, cwd) {
	const id = vfsIdentity(fs[FS_SOURCE]);
	const handle = openWindow({
		id: "grepDialog fileList " + encodeURI(id),
		title: `搜索文件内容 (${id})`,
		icon: <Icon_search/>,
		width: 500,
		height: 700,
		element: (handle) => {
			const patternEl = <input placeholder="输入要搜索的内容…" spellCheck={false}/>
			const pathEl = <input placeholder="在目录中…" spellCheck={false}/>
			const buttonClick = $state();
			let useRegex = false;
			let caseSensitive = false;
			let useGlob = false;

			const grepResult = $asyncState(async () => {
				let pattern = patternEl.value;
				if (!pattern) return false;

				if (!useRegex) pattern = escapeRegexp(pattern);
				if (!caseSensitive && (!useRegex || !pattern.endsWith(')'))) pattern += "(i)";

				const path = pathEl.value;
				const content = await callFileSystemFunc(fs, 'grep', {
					path: useGlob ? "" : path,
					glob: useGlob ? path : undefined,
					pattern,
					maxFiles: 100,
					maxMatchesPerFile: 50,
					context: 1
				});
				return grepCard(pattern, content, "", true);
			}, buttonClick);

			handle._sync = buttonClick;
			handle._pattern = patternEl;
			handle._path = pathEl;

			return <>
				<div className="-head">
					<div className="my-input -comp">
						<Icon_search/>
						{patternEl}
						<div className="-btn">
							<button title="区分大小写" onClick={({target}) => {
								caseSensitive = target.classList.toggle('active');
								$update(buttonClick);
							}}>Aa
							</button>
							<button title="正则表达式" onClick={({target}) => {
								useRegex = target.classList.toggle('active');
								$update(buttonClick);
							}}>.*
							</button>
						</div>
					</div>
					<div className="my-input -comp -path">
						<i className="icon ri-folder-line" />
						{pathEl}
						<div className="-btn">
							<button title="Glob 表达式" onClick={({target}) => {
								useGlob = target.classList.toggle('active');
								$update(buttonClick);
							}}>?*
							</button>
						</div>
					</div>
					<button className="btn primary" onClick={() => $update(buttonClick)}>搜索</button>
				</div>

				{$computed(() => {
					if (grepResult.loading) {
						return <div className="empty">
							<i className="spinner" style="width:44px;height:44px"/>
							<p>正在搜索…</p>
						</div>;
					} else if (grepResult.error) {
						return <div className="empty">
							<Icon_warning/>
							<p>搜索失败</p>
							<code>{grepResult.error.message ?? prettyError(grepResult.error)}</code>
							<button className="btn ghost" onClick={() => $update(buttonClick)}>重试</button>
						</div>;
					} else if (!grepResult.value) {
						return <div className="empty">
							<Icon_search/>
							<p>{patternEl.value ? `没有匹配 “${patternEl.value}” 的文件` : "输入内容开始搜索"}</p>
						</div>;
					} else {
						return grepResult;
					}
				}, [grepResult])}
			</>
		}
	});

	handle._path.value = unconscious(cwd);
	handle._pattern.value = "";
	$update(handle._sync);
}

const myNormalizePathAllowAbsolute = path => (path[0] === '/' && path.length > 1 ? '/' : '') + normalizePath(path).join('/');

/**
 * @param {AiChat.FileSystemInstance} fs
 * @param {import("unconscious").Reactive<string>} cwd
 * @return {{ navigateTo(path: string, hl?: Set<String>): Promise<void>, onFocus(boolean): void, element: JSX.Element }}
 */
export const createExplorerWidget = (fs, cwd) => {
	const myId = vfsIdentity(fs[FS_SOURCE]);

	// 几个监听器，VCS窗口需要用它 修改右键菜单，给文件行上色，以及插入被删除的文件
	let _onContextMenu = AS_IS, _onRenderRow = AS_IS, _onListFiles = AS_IS, _onRefresh = AS_IS;

	/**
	 * @param {string} op
	 * @param {Record<string, any>} [body]
	 */
	const call = (op, body) => callFileSystemFunc(fs, op, body);

	/* ------------------------------ 状态 ------------------------------ */
	const query = $state('');

	let highlightAfterChange = null;

	/**
	 * @type {import("unconscious").ReactivePromise<FileEntry[]>}
	 */
	const entries = $asyncState(async path => {
		const t = typeof highlightAfterChange === 'string' ? new Set([highlightAfterChange]) : highlightAfterChange;
		highlightAfterChange = null;

		const q = unconscious(query);

		const pattern = q ? `**/*${globSearch ? q : q.replace(GLOB_META_CHARS, '\\$&')}*` : '*';
		const entries = await _onListFiles(call('list', {
			path: path || '.',
			pattern,
			json: true,
			limit: q ? 1000 : 10000,
			//showDir: q ? false : undefined,
			showModified: true,
			showHidden: true,
		}), path, pattern);

		resetSel();

		const prefix = path || '';
		loadTreeChildren('').then(() => revealInTree(prefix));
		return entries.map(([name, type, size, mtime]) => {
			const path = joinPath(prefix, name);
			const e = {name, type, size: size || 0, mtime, path,};
			if (t?.has(path)) selection.add(e);
			return e;
		});
	}, cwd, []);

	const selection = $state(new Set());

	const sortKey = $state('name');
	const sortDir = $state(1);

	const terminalAvailable = call('terminal').then(() => true, () => {
		terminalBtn.remove();
		terminalBtn = null;
		return false;
	});

	let showThumb;
	checkThumbAbility(fs).then(a => showThumb = a);

	const terminal = async () => {
		if (!await terminalAvailable) {
			return showToast("该实现不支持", 'error');
		}
		return openTerminal(fs, cwd.value);
	};

	let terminalBtn = ref();
	let toastDiv = ref();
	let uploadDiv = ref();
	let scrollContainer = ref();

	// 纯命令式的临时状态
	let anchor = null;
	let searchDebounceTimer = 0;

	const sorter = new Intl.Collator(undefined, {numeric: true});

	/* ------------------------------ 派生值 ------------------------------ */
	const sorted = $computed(() => {
		const list = [...entries];
		const key = unconscious(sortKey);
		const dir = unconscious(sortDir);
		return list.sort((a, b) => {
			if (key !== 'size' && isDirectory(a) !== isDirectory(b)) return isDirectory(a) ? -1 : 1;

			let r = 0;
			if (key === 'size') r = (a.size) - (b.size);
			else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
			if (r === 0) r = sorter.compare(a.name, b.name);
			return r * dir;
		});
	});

	//region 列目录和搜索
	/**
	 * @param {string} path
	 * @param {boolean} [addHistory=true]
	 */
	function loadDir(path, addHistory = true) {
		cwd.value = path;
		query.value = '';
		$update(cwd);
		if (addHistory) pushHistory(path);
	}

	/**
	 * @param {string} q
	 */
	function doSearch(q) {
		query.value = q.trim();
		$update(cwd);
	}

	const searchPattern = $computed(() => {
		const value = unconscious(query);
		return value && new RegExp((globSearch ? parseGlobPattern(value, true) : escapeRegexp(value)), 'ig');
	});
	const highlightQuery = txt => escapeHtmlText(txt).replace(searchPattern.value, "<mark>$&</mark>");
	//endregion
	//region 历史
	const historyStack = $state([]);
	const historyIndex = $state(-1);

	/** @param {string} p */
	function pushHistory(p) {
		if (historyStack[historyIndex.value] === p) return;
		historyStack.length = ++historyIndex.value;
		historyStack.push(p);

		if (historyStack.length > 100) {
			historyStack.shift();
			historyIndex.value--;
		}
	}

	function goBack() {
		if (historyIndex.value <= 0) return;
		loadDir(historyStack[--historyIndex.value], false);
	}

	function goForward() {
		if (historyIndex.value >= historyStack.length - 1) return;
		loadDir(historyStack[++historyIndex.value], false);
	}

	function goUp() {
		if (cwd.value) loadDir(parentOf(cwd.value));
	}
	//endregion
	//region 顶部路径节点
	const crumbNodes = $computed(() => {
		const s = unconscious(cwd);
		/** @type {{label: string, target: string, last: boolean}[]} */
		const out = [{label: '根目录', target: '', last: !s}];
		if (s) {
			const parts = s.split('/');
			if (s[0] === '/' || parts[0].endsWith(':')) out.length = 0;
			parts.forEach((p, i) => out.push({label: p, target: parts.slice(0, i + 1).join('/'), last: i === parts.length - 1}));
		}
		return out;
	});
	const editingPath = $state(false);

	function startPathEdit() {
		if (editingPath.value) return;
		editingPath.value = true;
		pathInput.value = cwd.value;
		setTimeout(() => {
			pathInput.focus();
			pathInput.select();
		}, 0);
	}

	/** @param {boolean} go */
	function finishPathEdit(go) {
		if (!editingPath.value) return;
		editingPath.value = false;
		if (!go) return;
		loadDir(myNormalizePathAllowAbsolute(pathInput.value));
	}
	//endregion
	//region 目录树
	/** @type {boolean} */
	let isSmall;
	const ro = new ResizeObserver(ent => {
		isSmall = ent.at(-1).contentRect.width <= 640;
	});

	/** @type {Set<string>} */
	const treeOpen = new Set(['']);
	/** @type {Map<string[], string[]>} */
	const treeKids = new NestedMap();
	const treeTick = $state(0);
	const bumpTree = () => { treeTick.value++; };

	const treeRows = $computed(() => {
		/** @type {{path: string, depth: string}[]} */
		const rows = [];
		const walk = (path, depth) => {
			const kids = treeKids.get(path.split('/'));
			const open = treeOpen.has(path);
			rows.push({path, depth});
			if (open && kids) kids.forEach(k => walk(joinPath(path, k), depth + 1));
		};
		walk('', 0);
		return rows;
	}, [treeTick]);

	/**
	 * @param {string} path
	 */
	function invalidateTreeCache(path) {
		if (treeKids.delete(path.split('/'), true)) {
			if (treeOpen.has(path)) loadTreeChildren(path, true);
			else bumpTree();
		}
	}

	/**
	 * @param {string} path
	 * @param {boolean} [force]
	 * @return {Promise<string[]>}
	 */
	async function loadTreeChildren(path, force = false) {
		if (isSmall) return [];
		const keys = path.split('/');

		let s;
		if (!force && (s = treeKids.get(keys))) return s;

		const dirs = await _onListFiles(call('list', {
			path: path || '.', pattern: '*',
			json: true, showDir: 'only',
			limit: 1000
		}), path).then(list => list.map(x => x[0]), () => []);

		treeKids.set(keys, dirs);
		bumpTree();
		return dirs;
	}

	/**
	 * 展开到指定路径的所有祖先节点
	 * @param {string} path
	 */
	async function revealInTree(path) {
		treeOpen.add('');
		let acc = [];
		for (const p of path.split('/')) {
			acc.push(p);
			const merged = acc.join('/');
			treeOpen.add(merged);
			if (!treeKids.has(acc)) await loadTreeChildren(merged);
		}
	}

	/**
	 * @param {MouseEvent} ev
	 * @param {string} path
	 */
	function onTreeClick(ev, path) {
		const dontLoad = ev.target.closest(".ico");
		if (dontLoad) {
			if (treeOpen.delete(path)) {
				// FIXME 这个树的构造是可以优化的，比如这里可以换成splice
				bumpTree();
				return;
			}
		}

		treeOpen.add(path);
		if (!treeKids.has(path.split('/'))) loadTreeChildren(path);
		else bumpTree();

		if (!dontLoad) loadDir(path);
	}
	//endregion
	//region 选择
	/** @param {Set<FileEntry>} next */
	function applySel(next) {
		selection.value = next;
		$update(selection);
		syncChkAll();
	}

	function resetSel() {
		anchor = null;
		selection.value = new Set();
		syncChkAll();
	}

	function syncChkAll() {
		const list = unconscious(sorted);
		const first = list.findIndex(e => selection.has(e));
		chkAll.checked = first >= 0;
		chkAll.indeterminate = first < 0 ? false : first > 0 || !list.every(e => selection.has(e));
	}

	/** @param {FileEntry} path */
	function toggleSel(path) {
		const next = selection.value;
		next.has(path) ? next.delete(path) : next.add(path);
		anchor = path;
		applySel(next);
	}

	/**
	 * @param {FileEntry} path
	 * @param {PointerEvent} [ev]
	 */
	function selectRow(path, ev = {}) {
		const toggle = ev.ctrlKey || ev.metaKey;
		const range = ev.shiftKey;

		if (range && anchor != null) {
			const a = sorted.indexOf(anchor), b = sorted.indexOf(path);
			if (a >= 0 && b >= 0) {
				const next = new Set();
				for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(sorted[i]);
				applySel(next);
				return;
			}
		}
		if (toggle) return toggleSel(path);
		anchor = path;
		applySel(new Set([path]));
	}

	const selectAll = () => applySel(new Set(unconscious(sorted)));

	/**
	 * 当前被选中的条目（按目录列表顺序）
	 * @return {FileEntry[]}
	 */
	const getSelectedItems = () => {
		const sel = unconscious(selection);
		return unconscious(sorted).filter(e => sel.has(e));
	};
	//endregion
	//region 拖动选择
	/**
	 * @typedef {{startX: number, startY: number, x: number, y: number, el: HTMLElement, moved: boolean, _th: number, _fr: number, _to: number, _t: number}} MultiSelection
	 */
	/**
	 * @type {MultiSelection | null}
	 */
	let multiSelecting = null;
	let lastClickTarget, lastClickCount, clickTimer;

	/** @param {PointerEvent} ev */
	function onListPointerDown(ev) {
		if (multiSelecting || ev.button !== 0 || ev.pointerType !== 'mouse') return;
		const target = ev.target;
		if (!target.matches('.row') && target !== scrollContainer) return;

		const box = scrollContainer.getBoundingClientRect();
		// 点在滚动条上时不开始框选
		if (ev.clientX - box.left >= scrollContainer.clientWidth) return;
		if (ev.clientY - box.top >= scrollContainer.clientHeight) return;

		const toX = cx => cx - box.left + scrollContainer.scrollLeft;
		const toY = cy => cy - box.top + scrollContainer.scrollTop;

		clearTimeout(clickTimer);
		multiSelecting = {
			startX: toX(ev.clientX),
			startY: toY(ev.clientY),
			moved: false,
			ctrlKey: ev.ctrlKey || ev.metaKey,
			shiftKey: ev.shiftKey,
			target,
			detail: lastClickTarget === target ? lastClickCount + 1 : 1,
			_th: 0,
			_fr: 0,
			_to: -1,
			el: <div className="-selection"/>
		};

		const EDGE      = 24;
		const MAX_SPEED = 60;
		const ACCEL     = 80;

		const autoScrollHandler = (ts) => {
			const dt = multiSelecting._t ? Math.min((ts - multiSelecting._t) / 16.667, 3) : 1;
			multiSelecting._t = ts;

			const box = scrollContainer.getBoundingClientRect();

			// 拖到上下边缘附近时自动滚动
			const over = multiSelecting.y < box.top + EDGE ? multiSelecting.y - (box.top + EDGE)
				: multiSelecting.y > box.bottom - EDGE ? multiSelecting.y - (box.bottom - EDGE) : 0;

			if (over) {
				const d = Math.abs(over);
				// d=0 → 0；d 越大越快；d→∞ 时收敛到 MAX_SPEED
				const speed = MAX_SPEED * (1 - Math.exp(-d / ACCEL));
				scrollContainer.scrollTop += Math.sign(over) * speed * dt;
			}

			updateFileSelection(box, multiSelecting);
			multiSelecting._th = requestAnimationFrame(autoScrollHandler);
		};
		autoScrollHandler();

		scrollContainer.setPointerCapture(ev.pointerId);
		scrollContainer.addEventListener('pointermove', onListPointerMove);
		scrollContainer.addEventListener('pointerup', onListPointerUp, ONCE_EVENT);
	}

	/** @param {PointerEvent} ev */
	function onListPointerMove(ev) {
		multiSelecting.x = ev.clientX;
		multiSelecting.y = ev.clientY;
	}

	/** @param {PointerEvent} ev */
	function onListPointerUp(ev) {
		const m = multiSelecting;
		if (!m) return;
		multiSelecting = null;

		scrollContainer.removeEventListener('pointermove', onListPointerMove);
		cancelAnimationFrame(m._th);

		if (m.moved) {
			m.x = ev.clientX;
			m.y = ev.clientY;
			updateFileSelection(scrollContainer.getBoundingClientRect(), m);
			m.el.remove();
			//anchor = selection.value.entries().next().value;
		} else {
			const target = m.target;

			lastClickTarget = target;
			lastClickCount = m.detail;
			clickTimer = setTimeout(() => lastClickCount = 0, 500);

			if (!target.closest('.row')) resetSel();
			else target.dispatchEvent(new MouseEvent('click', m));
		}
	}

	/**
	 * @param {DOMRect} box
	 * @param {MultiSelection} m
	 */
	function updateFileSelection(box, m) {
		m.moved ||= Math.abs(m.x - m.startX) > 5 || Math.abs(m.y - m.startY) > 5;
		if (!m.moved) return;

		if (!m.el.isConnected) {
			resetSel();
			scrollContainer.append(m.el);
		}

		const vl = /** @type {VirtualList} */scrollContainer.firstElementChild.list;

		const toX = cx => cx - box.left + scrollContainer.scrollLeft;
		const toY = cy => cy - box.top + scrollContainer.scrollTop;

		const left = Math.max(Math.min(m.startX, toX(m.x)), 0);
		const right = Math.min(Math.max(m.startX, toX(m.x)), scrollContainer.clientWidth);
		const top = Math.max(Math.min(m.startY, toY(m.y)), 0);
		const bottom = Math.min(Math.max(m.startY, toY(m.y)), Math.max(vl._height + vl.itemHeight, scrollContainer.clientHeight));

		const style = m.el.style;
		style.transform = `translate(${left}px, ${top}px)`;
		style.width = right - left + 'px';
		style.height = bottom - top + 'px';

		const list = unconscious(sorted);

		const height = vl.itemHeight;

		const from = Math.max(0, Math.floor(top / height));
		const to = Math.min(list.length - 1, Math.ceil(bottom / height) - 1);

		const sel = unconscious(selection);
		const prevFrom = m._fr;
		const prevTo = m._to;

		if (from === prevFrom && to === prevTo) return;

		for (let i = prevFrom, end = Math.min(prevTo, from - 1); i <= end; i++) sel.delete(list[i]);
		for (let i = Math.max(prevFrom, to + 1), end = prevTo; i <= end; i++) sel.delete(list[i]);

		for (let i = from, end = Math.min(to, prevFrom - 1); i <= end; i++) sel.add(list[i]);
		for (let i = Math.max(from, prevTo + 1), end = to; i <= end; i++) sel.add(list[i]);

		m._fr = from;
		m._to = to;

		applySel(sel);
	}
	//endregion
	/**
	 * @param {FileEntry} e
	 * @param {boolean} [edit]
	 */
	const openEntry = (e, edit) => {
		if (isDirectory(e)) loadDir(e.path);
		else {
			if (IMAGE_EXT.test(e.name)) {
				const images = sorted.filter(e => IMAGE_EXT.test(e.name));
				vfsPreviewImage(images, fs, images.indexOf(e));
				return;
			}
			vfsPreview(fs, e.path, e.name, edit ? 'y' : 'a', e);
		}
	};

	const refresh = () => {
		if (_onRefresh()) return;
		$update(cwd);
	};

	const createNameConflictResolver = () => {
		const set = new Set([...entries.map(e => e.name)]);
		return initName => {
			initName = initName.replaceAll(/[:<>\\/*?|"]/g, '-');

			let ord = 1;
			const pos = initName.lastIndexOf('.');

			let name = initName;
			while (set.has(name)) {
				name = pos < 0 ? initName + ` (${ord})` : `${initName.slice(0, pos)} (${ord})${initName.slice(pos)}`;
				ord++;
			}

			set.add(name);
			return name;
		};
	};

	//region 右键菜单
	/**
	 * @param {MouseEvent} ev
	 * @param {FileEntry} e
	 */
	async function onRowMenu(ev, e) {
		ev.preventDefault();
		ev.stopPropagation();

		const targets = selection.value.has(e) ? getSelectedItems() : (selectRow(e), [e]);
		const multi = targets.length > 1;

		const items = [];

		if (!multi) {
			const isDir = isDirectory(e);
			const testResult = isDir ? 'n' : await vfsPreview(fs, e.path, e.name, 't', e);
			if (testResult !== 'y') items.push({label: isDir ? '打开' : '预览', icon: isDir ? "ri-folder-line" : "ri-eye-line", act: () => openEntry(e)},);
			if (testResult !== 'n') items.push({label: '编辑', icon: "ri-edit-2-line", act: () => openEntry(e, true)},);
		}

		items.push(
			{label: '下载', icon: "ri-download-line", act: () => downloadEntries(targets)},
		);

		if (!multi) {
			items.push(
				{label: '复制路径', icon: "ri-link", act: () => copyWithAnimation(myId + targets.at(-1).path)},
			);
		}

		items.push(
			{sep: true},
			{label: '剪切', icon: "ri-scissors-line", act: () => setClipboard(targets, true)},
			{label: '复制', icon: "ri-file-copy-line", act: () => setClipboard(targets, false)},
		);

		if (!multi) {
			items.push(
				{label: '重命名', icon: "ri-input-cursor-move", act: () => renameEntry(e)},
				{label: '属性', icon: "ri-information-line", act: async () => {
					const e = targets[0];
					const stat = await call('stat', { path: e.path, json: true });
					openWindow({
						id: "vfsStat "+encodeURI(myId+e.path),
						title: e.name+" 属性",
						icon: <i className="ri-information-line" />,
						width: 360,
						height: 420,
						element: <>
							<dl className="lr-list">
								<dt>位置</dt>
								<dd>{e.path}</dd>
								{...Object.entries(stat).map(([k, v]) => (<>
									<dt>{k}</dt>
									<dd>{v}</dd>
								</>))}
							</dl>
						</>
					})
				}},
			);
		}

		items.push(
			{sep: true},
			{
				label: `删除`,
				icon: "ri-delete-bin-line",
				danger: true,
				act: () => deleteEntries(targets),
			},
		);

		openMenu(ev, scrollContainer, _onContextMenu(items, targets));
	}

	/** 空白处右键 @param {MouseEvent} ev */
	function onBlankMenu(ev) {
		if (entries.error) return;

		ev.preventDefault();
		resetSel();
		const items = [
			{label: '刷新', icon: "ri-loop-right-line", act: refresh},
			{sep: true},
			{label: '粘贴', icon: "ri-clipboard-line", disabled: !clipboard.value, act: paste},
		];
		if (terminalAvailable) {
			items.push(
				{label: '打开终端', icon: "ri-terminal-line", act: terminal},
			);
		}
		items.push(
			{label: '搜索文件内容', icon: <Icon_search/>, act: () => openGrepDialog(fs, cwd)},
			{sep: true},
			{label: '上传文件', icon: "ri-upload-line", act: () => fileInput.click()},
			{label: '新建文件夹', icon: "ri-folder-add-line", act: newFolder},
			{label: '新建文件', icon: "ri-file-add-line", act: newFile},
		);
		openMenu(ev, scrollContainer, items);
	}
	//endregion
	//region 剪贴板
	/**
	 * @param {FileEntry | FileEntry[]} items
	 * @param {boolean} cut
	 */
	const setClipboard = (items, cut) => {
		if (!items.length) return;
		clipboard.value = {fs, cut, items};
	};

	async function paste() {
		const c = unconscious(clipboard);
		if (!c) return;

		const resolver = createNameConflictResolver();
		/** @type {string[]} */
		const pasted = [];
		const fail = [];

		const _cwd = unconscious(cwd);

		let {cut, items, fs: srcFS} = c;

		for (const it of items) {
			const path = it.path;
			a:
			if (srcFS === fs && cut) {
				if (_cwd === parentOf(path)) {
					fail.push(it.name + ' — ' + '目标文件夹和源相同');
				} else if (_cwd === path || _cwd.startsWith(path + '/')) {
					fail.push(it.name + ' — ' + '目标文件夹是源文件夹的子文件夹');
				}
				else break a;
				continue;
			}

			const dest = joinPath(_cwd, resolver(it.name));
			try {
				await vfsCopyMove(srcFS, path, fs, dest, cut);
				pasted.push(dest);
				if (isDirectory(it)) {
					invalidateTreeCache(parentOf(path));
					invalidateTreeCache(parentOf(dest));
				}
			} catch (e) {
				fail.push(it.name + ' — ' + (e.message ?? e));
			}
		}

		$update(cwd);

		if (fail.length) mdiToast(toastDiv, fail.length === 1 ? `粘贴失败: ` + fail[0] : `${fail.length === items.length ? '全部' : `${fail.length} / ${items.length} 项`}粘贴失败:\n` + fail.join('\n'), pasted.length ? 'warn' : 'err')
		if (!pasted.length) return;
		if (cut) clipboard.value = null;
		highlightAfterChange = new Set(pasted);
	}
	//endregion
	//region 新建 / 改名 / 删除
	function newFolder() {
		const e = {
			name: "新建文件夹",
			time: Date.now(),
			type: 'dir'
		};
		processNameInput(e, () => {
			const name = e.name;
			if (!name) {
				const idx = sorted.indexOf(e);
				sorted.splice(idx, 1);
				return;
			}

			const path = joinPath(cwd.value, name);
			call('mkdir', {path}).then(
				() => {
					highlightAfterChange = path;
					$update(cwd);
					invalidateTreeCache(cwd.value);
				},
				(e) => {
					$update(cwd);
					mdiToast(toastDiv, '创建失败：' + (e.message ?? e), 'err')
				}
			);
		}, true);
	}

	function newFile() {
		const e = {
			name: "新建文本文档.txt",
			time: Date.now(),
			type: 'file',
			size: 0
		};
		processNameInput(e, () => {
			const name = e.name;
			if (!name) {
				const idx = sorted.indexOf(e);
				sorted.splice(idx, 1);
				return;
			}

			const path = joinPath(cwd.value, name);
			call('write', {path, content: ''}).then(
				() => {
					highlightAfterChange = path;
					$update(cwd);
				},
				(e) => {
					$update(cwd);
					mdiToast(toastDiv, '创建失败：' + (e.message ?? e), 'err')
				}
			);
		}, true);
	}

	/** @param {FileEntry} e */
	function renameEntry(e) {
		const old = e.name;
		processNameInput(e, () => {
			const name = e.name;
			if (old === name || !name) {
				delete e.edit;
				$update(sorted);
				return;
			}

			const src = e.path;
			const dest = joinPath(cwd.value, name);
			call('copy', {src, dest, move: true, overwrite: false}).then(() => {
				highlightAfterChange = dest;
				$update(cwd);
				if (isDirectory(e)) {
					invalidateTreeCache(parentOf(src));
					invalidateTreeCache(parentOf(dest));
				}
			}, (e) => {
				mdiToast(toastDiv, '重命名失败：' + (e.message ?? e), 'err')
				$update(cwd);
			});
		});
	}

	function processNameInput(e, save2, add) {
		if (auxSmallScreen || !sorted.length) {
			openModal({
				title: "输入名称",
				type: "input",
				value: e.name,
				onConfirm(text) {
					e.name = text;
					save2();
				},
				onCancel() {}
			})
			return;
		}

		const save = () => {
			if (!save2) return;
			input.disabled = true;
			save2();
			save2 = null;
		}

		if (add) sorted.push(e);
		else $update(sorted);

		const dot = e.name.lastIndexOf('.');
		const input = <input className="text-input" spellCheck={false} value={e.name} onInput={({currentTarget}) => {
			e.name = currentTarget.value;
		}} onKeyDown={ev => {
			if (ev.key === 'Enter') save();
		}} onBlur={save} />;

		queueMacrotask(() => {
			if (!input.isConnected) {
				delete e.edit;
				return;
			}

			input.focus();
			if (!isDirectory(e) && dot > 0) input.setSelectionRange(0, dot);
			else input.select();
		});

		e.edit = input;
		return input;
	}

	/**
	 * @param {FileEntry[]} [items]
	 */
	function deleteEntries(items) {
		if (!items.length) return;

		const dialog = openModal({
			title: "删除多个项目",
			accent: "danger",
			message: <>
				<div className="fa-alert row">
					<div className="row">
						<Icon_warning/>
						<div className="col">
							<b>确实要将这 {items.length} 项永久删除吗？</b>
							<span className="desc">
						文件将从磁盘直接删除，不进入回收站。</span>
						</div>
					</div>
				</div>
				<div>
					{items.slice(0, 8).map(it => <div><code>{it.path}</code></div>)}
					{items.length > 8 ? <div>…另有 {items.length - 8} 项</div> : null}
				</div>
			</>,
			async onConfirm() {
				dialog.querySelectorAll("button").forEach(b => b.remove());

				const deleted = [];
				const fail = [];
				let all = items.map(it => call('delete', {path: it.path, recursive: true, force: false}).then(() => {
					deleted.push(it);
				}, e => {
					fail.push(it.name + ' — ' + e.message);
				}));
				await Promise.allSettled(all);

				if (fail.length) mdiToast(toastDiv, fail.length === 1 ? `删除失败: ` + fail[0] : `${fail.length === items.length ? '全部' : `${fail.length} / ${items.length} 项`}删除失败:\n` + fail.join('\n'), deleted.length ? 'warn' : 'err')
				$update(cwd);
				if (!deleted.length) return;

				deleted.forEach(it => {
					if (isDirectory(it)) invalidateTreeCache(parentOf(it.path));
				});
			}
		});
	}
	//endregion
	//region 上传和下载
	const dropActive = $state(false);
	let dragDepth = 0;

	/**
	 * 下载若干条目：单个直接下载，多个打包为 zip
	 * @param {FileEntry[]} items
	 */
	async function downloadEntries(items) {
		if (!items.length) return;
		try {
			let commonPath = items[0].path;
			items.forEach(item => {
				const p = item.path;
				for (let i = 0; i < p.length; i++) {
					if (commonPath[i] !== p[i]) {
						commonPath = commonPath.slice(0, i);
						break;
					}
				}
			})

			if (commonPath.endsWith('/'))
				commonPath = commonPath.slice(0, -1);

			await vfsDownloadMultiple(
				fs,
				items,
				baseName(commonPath),
			);
		} catch (err) {
			mdiToast(toastDiv, '下载失败：' + (err.message ?? err), 'err')
		}
	}

	/** @param {File[]} files */
	async function uploadFiles(files) {
		const resolve = createNameConflictResolver();
		const [enqueue, flush] = createAsyncQueue(4);
		for (const f of files) {
			await enqueue(() => startUpload(f, resolve(f.name)));
		}
		await flush();
	}

	/**
	 * @param {File} f
	 * @param {string} name
	 */
	async function startUpload(f, name) {
		const cancel = new AbortController();
		const signal = cancel.signal;

		const pct = <span className="pct" />;
		const bar = <div className="timer" style="animation:none;transform:scaleX(0)" />;
		const el = <div className="toast info">
			<span className="ellipsis" title={name}>{name}</span>
			{pct}
			{bar}
			<button className="dct-undo" onClick={({target}) => {
				target.remove();
				cancel.abort();
			}}>取消
			</button>
		</div>;
		uploadDiv.append(el);

		const target = joinPath(cwd.value, name);

		let p;

		const kind = fs[FS_SOURCE].fs_type;
		if (f.size && (kind === 'api' || kind === 'db')) {
			const {base, root, headers} = await call('getUrl');
			p = xhrUpload(f, base+`writeRaw?${root ? "root="+encodeURIComponent(root)+"&" : ''}path=`+encodeURIComponent(target), headers, signal, p => {
				bar.style.width = (p * 100).toFixed(1) + '%';
				pct.textContent = Math.floor(p * 100) + '%';
			})
		} else {
			p = call('writeRaw', { path: target, content: f, signal });
		}

		return p.then(() => {
			mdiToast(toastDiv, '上传成功：' + name, 'ok')
		}, (err) => {
			mdiToast(toastDiv, '上传失败：' + name + ' — ' + err.message, 'err')
		}).finally(() => {
			highlightAfterChange = new Set([...selection].map(e => e.path));
			highlightAfterChange.add(target);
			$update(cwd);
			el.remove();
		});
	}

	/* 拖拽上传 */
	/** @param {DragEvent} ev */
	const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');

	/** @param {DragEvent} ev */
	function onDragEnter(ev) {
		if (!hasFiles(ev)) return;
		ev.preventDefault();
		dragDepth++;
		dropActive.value = true;
	}

	/** @param {DragEvent} ev */
	function onDragOver(ev) {
		if (hasFiles(ev)) ev.preventDefault();
	}

	/** @param {DragEvent} ev */
	function onDragLeave(ev) {
		if (!hasFiles(ev)) return;
		if (--dragDepth <= 0) {
			dragDepth = 0;
			dropActive.value = false;
		}
	}

	/** @param {DragEvent} ev */
	function onDrop(ev) {
		if (!ev.dataTransfer?.files?.length) return;
		ev.preventDefault();
		dragDepth = 0;
		dropActive.value = false;
		uploadFiles([...ev.dataTransfer.files]);
	}
	//endregion
	//region 视图(未实现) / 排序
	/** @param {string} key */
	function sortBy(key) {
		if (sortKey.value === key) sortDir.value = -sortDir.value;
		else {
			sortKey.value = key;
			sortDir.value = 1;
		}
	}

	/** @param {string} key */
	const arrowOf = key => sortKey.value === key ? (sortDir.value > 0 ? '↑' : '↓') : '';

	const scrollToSelectedItem = (ev, idx) => {
		ev.preventDefault();
		scrollContainer.firstElementChild.list.scrollIntoView(idx < 0 ? sorted.length + idx : idx, {
			block: 'nearest',
			behavior: 'smooth'
		});
	};
	//endregion
	//region 键入跳转
	const TYPEAHEAD_GAP = 800;

	let taPrefix = '';
	let taPrevTime = 0;
	let taPrevHit;

	const taHint = <div className="ta-hint"><span className="ellipsis"/></div>;
	let taHintTimer;

	/** @param {string} text */
	function showTypeHint(text) {
		taHint.firstElementChild.textContent = text;
		clearTimeout(taHintTimer);
		if (text) {
			body.append(taHint);
			taHintTimer = setTimeout(() => taHint.remove(), TYPEAHEAD_GAP);
		} else {
			taHint.remove();
		}
	}

	/**
	 * 按前缀跳转到第一个名字匹配的条目
	 * @param {string} ch
	 */
	function typeahead(ch) {
		const list = unconscious(sorted);
		if (!list.length) return;

		const now = performance.now();
		if (now - taPrevTime > TYPEAHEAD_GAP) taPrefix = '';

		let re = new RegExp('^'+escapeRegexp(taPrefix += ch), 'i');
		let hit = list.findIndex(e => re.test(e.name));

		const prev = taPrevHit;
		taPrevHit = hit;

		if (hit < 0) {
			showTypeHint('');
			if (prev >= 0) mdiToast(toastDiv, `没有以 “${taPrefix}” 开头的项目`, 'warn', 1000);
			return;
		}

		taPrevTime = now;

		showTypeHint(taPrefix);
		selectRow(list[hit]);
		scrollContainer.firstElementChild.list.scrollIntoView(hit, { block: 'nearest' });
	}
	//endregion
	//region 键盘操作
	/**
	 * @param {KeyboardEvent} ev
	 */
	function onGlobalKey(ev) {
		if (ev.isComposing || document.elementFromPoint(0,0).matches('dialog.modal')) return;

		const tag = (ev.target.tagName || '').toLowerCase();
		const typing = (tag === 'input' && ev.target.type !== 'checkbox') || tag === 'textarea' || ev.target.isContentEditable;
		const ctrlKey = ev.ctrlKey || ev.metaKey;
		const shiftKey = ev.shiftKey;
		const origKey = ev.key;
		const key = origKey.toLowerCase();

		if (ctrlKey) {
			if (key === 'l') {
				ev.preventDefault();
				startPathEdit();
				return;
			}
			if (key === 'r') {
				ev.preventDefault();
				refresh();
				return;
			}
			if (key === 'f') {
				ev.preventDefault();
				searchInput.focus();
				return;
			}
		}

		if (typing) return;

		if (origKey === 'Backspace') {
			ev.preventDefault();
			goUp();
			return;
		}
		if (origKey === '/') {
			ev.preventDefault();
			searchInput.focus();
			return;
		}

		const firstItem = selection.value.keys().next().value;
		const selectedCount = selection.value.size;
		if (origKey === 'F2' && selectedCount === 1) {
			ev.preventDefault();
			renameEntry(firstItem);
			return;
		}
		if (origKey === 'Delete' && selectedCount) {
			ev.preventDefault();
			deleteEntries(getSelectedItems());
			return;
		}

		if (ctrlKey) {
			if (key === 'a') {
				ev.preventDefault();
				selectAll();
				return;
			}
			if (key === 'c' && selectedCount) {
				setClipboard(getSelectedItems(), false);
				return;
			}
			if (key === 'x' && selectedCount) {
				setClipboard(getSelectedItems(), true);
				return;
			}
			if (key === 'v' && clipboard.value) {
				paste();
				return;
			}
		}

		if (origKey === 'Enter' && selectedCount === 1) {
			const e = entries.value.find(x => x === firstItem);
			if (e) openEntry(e);
		}

		if (!sorted.length) return;

		if (!ctrlKey && !ev.altKey && key.length === 1) {
			ev.preventDefault();
			typeahead(key);
			return;
		}

		if (origKey === 'ArrowDown') {
			let idx = 0;
			let item;
			if (selectedCount === 0) {
				item = sorted[0];
			} else {
				if (selectedCount > 1) {
					selection.value.forEach(i => item = i);
				} else {
					item = firstItem;
				}

				item = sorted[idx = sorted.indexOf(item)+1] ?? sorted[idx = 0];
			}

			selectRow(item, ev);
			scrollToSelectedItem(ev, idx);
			return;
		}

		if (origKey === 'ArrowUp') {
			let idx;
			let item;
			if (selectedCount === 0) {
				item = sorted.at(idx = -1);
			} else {
				item = firstItem;
				item = sorted.at(idx = sorted.indexOf(firstItem)-1);
			}

			selectRow(item, ev);
			scrollToSelectedItem(ev, idx);
		}
	}
	//endregion

	/* ------------------------------ 行 / 空状态 ------------------------------ */
	/**
	 * @param {FileEntry} e
	 * @return {JSX.Element}
	 */
	function makeRow(e) {
		const isDir = isDirectory(e);
		let icon;

		if (isDir) {
			icon = <span className="ico ri-folder-fill" />;
		} else {
			if (showThumb && IMAGE_EXT.test(e.name)) {
				icon = <span className="ico">{createThumbImage(fs, e/*, 64*/)}</span>;
			} else {
				const iconClass = iconClassOf(extOf(e.name));
				icon = <span className={"ico "+iconClass} style={`color:${iconColorOf(iconClass)}`} />;
			}
		}

		return _onRenderRow(<div className="row"
					class:sel={() => selection.has(e)}
					class:cut={() => cutPaths.has(e.path)}
					onClick={ev => {
						if (ev.target.nodeName === "INPUT") return;
						if (ev.detail === 1) {
							selectRow(e, ev);
						} else {
							openEntry(e);
							clearTimeout(e.timer);
						}
					}}
					onContextMenu={ev => onRowMenu(ev, e)}>
			<div className="chk">
				<input type="checkbox" tabIndex={-1}
					   checked={() => selection.has(e)}
					   onChange={() => toggleSel(e)}/>
			</div>
			<div className="name">
				{icon}
				{e.edit ?? <span className="ellipsis" title={e.name} onClick={ev => {
					if (!auxMainlyTouch && !e.edit && selection.has(e) && selection.size === 1) {
						clearTimeout(e.timer);
						e.timer = setTimeout(() => {
							if (selection.has(e) && selection.size === 1) {
								renameEntry(e);
							}
						}, 500);
					}
				}} dangerouslySetInnerHTML={query.value ? highlightQuery(e.name) : escapeHtmlText(e.name)} />}
			</div>
			<div className="time">{formatDate('Y-m-d H:i', e.mtime)}</div>
			<div className={'size'}>{isDir ? '' : formatSize(e.size)}</div>
		</div>, e);
	}

	/* ------------------------------ 元素 ------------------------------ */
	const pathInput = <input placeholder="输入路径，例如 Documents/项目 或 /root" spellCheck={false}
		style:display={() => editingPath.value ? '' : 'none'}
		onKeyDown={ev => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				finishPathEdit(true);
			} else if (ev.key === 'Escape') {
				ev.stopPropagation();
				finishPathEdit(false);
			}
		}}
		onBlur={() => finishPathEdit(false)}/>;

	const chkAll = <input type="checkbox" title="全选"
		style="width:16px;height:16px;accent-color:var(--accent);cursor:pointer"
		onChange={ev => ev.target.checked ? selectAll() : applySel(new Set())}/>;

	let globSearch = false;
	const searchInput = <input placeholder="搜索此目录" spellCheck={false}
		value={query}
		onInput={ev => {
			clearTimeout(searchDebounceTimer);
			const v = ev.target.value;
			searchDebounceTimer = setTimeout(() => {
				if (v.trim()) doSearch(v);
				else if (query.value) {
					query.value = '';
					$update(cwd);
				}
			}, 500);
		}}
		onKeyDown={ev => {
			if (ev.key !== 'Escape') return;
			ev.target.value = '';
			ev.target.blur();
			$update(cwd);
		}}
		onFocus={() => searchInput.select()}
	/>;

	const fileInput = <input type="file" multiple hidden
		 onChange={ev => {
			 const files = [...ev.target.files];
			 ev.target.value = '';
			 if (files.length) uploadFiles(files);
	}}/>;

	const body = <div className="explorer" onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
		<div className="-left col">
			<div className="tree">{$vforeach(treeRows, ({depth, path}) => {
				const kids = treeKids.get(path.split('/'));
				const open = treeOpen.has(path);
				const hasKids = kids?.length;

				return <div className="row"
							class:active={() => cwd.value === path}
							style={`--d:${depth}`}
							onClick={ev => onTreeClick(ev, path)}>
					<span
						className={`ico ri-folder${open && hasKids ? '-open' : ''}-${kids != null ? 'fill' : 'line'}`}/>
					<span className="ellipsis">{baseName(path) || '根目录'}</span>
				</div>;
			}, ({path}) => path+'\0'+(+treeOpen.has(path))+(+(treeKids.get(path.split('/'))!=null)), { volatileValue: true })}</div>
			<div className="fab">
				<div className="dropdown">
					<button className="ri-upload-line btn ghost" onClick={() => {
						if (auxMainlyTouch) return;
						fileInput.click()
					}}>上传…
					</button>
					<div className="list mid up">
						{IS_ANDROID_BUILD && <label className="ri-camera-4-fill" onClick={() => {webviewUploadImage().then(b => uploadFiles([b]))}}>拍照上传</label>}
						<label className="ri-mic-fill" role="button" tabIndex={0} onClick={() => {
							openRecorder().then(b => uploadFiles([b]), () => {})
						}}>录音上传</label>
						<label className="ri-attachment-2" role="button" tabIndex={0} onClick={() => fileInput.click()}>选择文件</label>
						<label ref={terminalBtn} className="ri-terminal-line btn ghost" tabIndex={0} onClick={terminal}>打开终端</label>
					</div>
				</div>
			</div>
		</div>

		<main className="col">
			<div className="toolbar">
				<button className="ri-arrow-left-s-line tbtn" title="后退"
						disabled={() => unconscious(historyIndex) === 0} onClick={goBack}/>
				<button className="ri-arrow-right-s-line tbtn" title="前进"
						disabled={() => unconscious(historyIndex) >= historyStack.length - 1} onClick={goForward}/>
				<button className="ri-arrow-up-line tbtn" title="返回上级" disabled={() => !cwd.value} onClick={goUp}/>

				<div className="crumbs" onClick={startPathEdit}>
				<span style:display={() => editingPath.value ? 'none' : 'contents'}>
					{$foreach(crumbNodes, c => {
						const btn = <button className={'crumb' + (c.last ? ' last' : '')} title={c.target || '/'}
											onClick.stop={() => {
												if (c.target !== cwd.value) loadDir(c.target);
											}}>{c.label}</button>;
						if (c.last) setTimeout(() => btn.scrollIntoView({inline: 'end', block: 'nearest'}), 0);
						return <span style="display:contents">{btn}{c.last ? null : <span className="sep">/</span>}</span>;
					}, JSON.stringify)}
				</span>
					{pathInput}
				</div>
				<button style="border-right: 1px solid var(--border);" className="ri-loop-right-line icon-btn" title="刷新" onClick={refresh} />
				<div className="my-input">
					<Icon_search/>
					{searchInput}
					<div className="-btn">
						<button title="Glob 表达式" onClick={({target}) => {
							globSearch = target.classList.toggle('active');
							searchInput.dispatchEvent(new KeyboardEvent('input'));
						}}>?*</button>
					</div>
				</div>
			</div>

			<div className="head">
				<div>{chkAll}</div>
				<div className="sortable" class:on={() => sortKey.value === 'name'} onClick={() => sortBy('name')}>
					名称<span className="-arrow">{() => arrowOf('name')}</span>
				</div>
				<div className="sortable r time" class:on={() => sortKey.value === 'mtime'} onClick={() => sortBy('mtime')}>
					修改时间<span className="-arrow">{() => arrowOf('mtime')}</span>
				</div>
				<div className="sortable r" class:on={() => sortKey.value === 'size'} onClick={() => sortBy('size')}>
					大小<span className="-arrow">{() => arrowOf('size')}</span>
				</div>
			</div>

			<div ref={scrollContainer} className="scroll fileList" onPointerDown={onListPointerDown} onContextMenu={onBlankMenu}>
				{$computed(() => {
					if (entries.loading) {
						return <div className="empty">
							<i className="spinner" style="width:44px;height:44px" />
							<p>正在读取目录…</p>
						</div>;
					} else if (entries.error) {
						return <div className="empty">
							<Icon_warning />
							<p>无法读取该目录</p>
							<code>{entries.error.message ?? prettyError(entries.error)}</code>
							<button className="btn ghost" onClick={() => $update(cwd)}>重试</button>
						</div>;
					} else if (!entries.length) {
						if (query.value) {
							return <div className="empty">
								<Icon_search />
								<p>没有匹配 “{query.value}” 的文件</p>
							</div>;
						}
						return <div className="empty">
							<i className="ri-folder-unknow-line" />
							<p>这个目录是空的</p>
							<p style="font-size:12px;color:var(--dim)">可以把文件拖进来上传</p>
						</div>;
					} else {
						return $vforeach(sorted, makeRow, k => k.edit ?? k);
					}
				}, [entries])}
			</div>

			<div className="statusbar" onContextMenu={onBlankMenu}>
				<span>{() => sorted.length} 项 | {() => {
					if (selection.size) {
						let bytes = 0;
						entries.forEach(e => {
							if (selection.value.has(e)) {
								if (isDirectory(e)) {
									bytes = -Infinity;
								} else {
									bytes += e.size;
								}
							}
						});

						return `已选 ${selection.size} 项${bytes >= 0 ? ` · ${formatSize(bytes)}` : ''}`
					}
				}}</span>
				<span style:display={() => clipboard.value ? '' : 'none'}>
					{() => clipboard.cut ? '剪切：' : '复制：'}
					{() => {
						const items = clipboard.items;
						if (!items?.length) return '';
						return baseName(items[0].path) + (items.length > 1 ? ` 和其它 ${items.length-1} 项` : '');
					}}
				</span>
			</div>
		</main>

		{() => unconscious(dropActive) ? <div className="dropMask">
			<div className="box">
				<b>释放以上传</b>
				<span>{() => cwd.value || '/'}</span>
			</div>
		</div> : null}

		<div className="uploads" ref={uploadDiv} />
		<div className="win-toasts" ref={toastDiv} />
	</div>;

	/* ------------------------------ 启动 ------------------------------ */

	// this is a hack (监听器移除时不递归取消注册)
	$watch(sorted, AS_IS);

	ro.observe(body);
	$cleanup(body, () => {
		ro.disconnect();
		$unwatch(sorted, AS_IS);
	});

	$cleanup(body, EVENT_BUS.onoff('fileChanged', (fs1, _, path, type) => {
		const itId = vfsIdentity(fs1[FS_SOURCE]);

		if (itId !== myId) {
			if (!itId.startsWith(myId)) return;
			path = itId.slice(myId.length) + path;
		}

		const dir = unconscious(cwd);
		const pathParent = parentOf(path);
		invalidateTreeCache(pathParent);
		if (dir === path || dir === pathParent) {
			highlightAfterChange = new Set([...selection].map(e => e.path));
			$update(cwd);
		}
	}));

	return {
		element: body,
		navigateTo(cwd, highlight) {
			loadDir(myNormalizePathAllowAbsolute(cwd));
			highlightAfterChange = highlight;
		},
		/**
		 * @param {function(menu: MenuItem[], selection: FileEntry[]): MenuItem[]} onContextMenu
		 * @param {function(el: JSX.Element, item: FileEntry): JSX.Element} onRenderRow
		 * @param {function(entries: Promise<FileEntry[]>, path: string, pattern?: string): Promise<FileEntry[]>}  onListFiles
		 * @param {function(): void} onRefresh
		 */
		_on(onContextMenu, onRenderRow, onListFiles, onRefresh) {
			_onContextMenu = onContextMenu;
			_onRenderRow = onRenderRow;
			_onListFiles = onListFiles;
			_onRefresh = onRefresh;
			return {selection};
		},
		onFocus(isFocused) {
			if (isFocused) document.addEventListener('keydown', onGlobalKey);
			else document.removeEventListener('keydown', onGlobalKey)
		}
	};
};