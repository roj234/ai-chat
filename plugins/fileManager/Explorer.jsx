import {openWindow} from "/src/components/Windows.jsx";

import "./Explorer.css";
import {$asyncState, $cleanup, $computed, $foreach, $state, $update, $vforeach, $watch, unconscious} from "unconscious";
import {auxMainlyTouch, auxSmallScreen, EVENT_BUS, selectedConversation} from "/src/states.js";
import {callFileSystemFunc, createFileSystem, FS_SOURCE, vfsIdentity} from "../agent/index.js";
import {vfsPreview} from "./preview.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {ref} from "@roj234/shared";
import {Icon_search, Icon_warning} from "/src/components/Icons.jsx";
import {formatDate, formatSize} from "unconscious/common/Utils.js";
import {normalizePath} from "@roj234/shared/path";
import {queueMacrotask} from "unconscious/common/queueMacrotask.js";
import {showToast} from "/src/components/Toast.js";
import {iconClassOf, iconColorOf} from "./fileTypes.js";
import {copyWithAnimation, prettyError} from "/src/utils/utils.js";
import {openTerminal} from "./Terminal.jsx";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {webviewUploadImage} from "/vendor/jsBridge.js";
import {openRecorder} from "../voiceInput/Recorder.jsx";
import {vfsDownloadMany} from "./downloader.js";
import {vfsCopyMove} from "../agent/Mounts.js";
import {createAsyncQueue} from "/common/pure-utils.js";
import {xhrUpload} from "./xhrUploader.js";

/* ============================== 工具函数 ============================== */

/**
 * 目录项
 * @typedef {Object} FileEntry
 * @property {string} name
 * @property {'file' | 'dir'} type
 * @property {number} size
 * @property {number} mtime
 * @property {string} path
 * @property {HTMLInputElement?} edit
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

/* ============================== 图标 ============================== */

const iconFolder2 = () => <div className="icon ri-folder-fill" style="background:linear-gradient(135deg,#4f8cff,#a371f7);background-clip:text;-webkit-text-fill-color:transparent;-webkit-background-clip:text;" />;

/** toast 左侧的小圆点字符 */
const TOAST_ICON = {ok: '✓', err: '×', warn: '!', info: 'i'};

/* ============================== 入口 ============================== */

/**
 * 现在 FileBrowserInterface 也算"真的存在"了
 * @param {AiChat.FileSystemInstance} [fs]
 * @param {string} [path]
 * @return {Promise<import("/src/components/Windows.jsx").WindowState>}
 */
export const openFileBrowser = async (fs, path = '') => {
	fs ??= await createFileSystem(unconscious(selectedConversation));

	const fsId = vfsIdentity(fs[FS_SOURCE]);
	const cwd = $state("文件管理");
	const browser = openWindow({
		id: "preview "+encodeURI(fsId),
		title: $computed(() => fsId + (unconscious(cwd) || '')),
		icon: iconFolder2(),
		element: () => Explorer(fs, cwd),
	});
	await browser.element.navigateTo(path);
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

/**
 * @param {AiChat.FileSystemInstance} fs
 * @param {import("unconscious").Reactive<string>} cwd
 * @return {JSX.Element & { navigateTo(string): Promise<void> }}
 */
const Explorer = (fs, cwd) => {
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

		const entries = await call('list', {
			path: path || '.',
			pattern: q ? `**/*${q.replace(/[*?[\]{}\\#%]/g, '')}*` : '*',
			json: true,
			limit: q ? 200 : 5000,
			showModified: true,
			showHidden: true,
		});

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

	const historyStack = $state([]);
	const historyIndex = $state(-1);

	const editingPath = $state(false);
	const dropActive = $state(false);

	const terminalAvailable = call('terminal').then(() => true, () => {
		terminalBtn.remove();
		terminalBtn = null;
		return false;
	});
	const terminal = async () => {
		if (!await terminalAvailable) {
			return showToast("该实现不支持", 'error');
		}
		return openTerminal(fs, cwd.value);
	};

	let terminalBtn = ref();
	let toastDiv = ref();
	let uploadDiv = ref();

	// 目录树：Set/Map 就地修改，靠 treeTick 通知
	/** @type {Set<string>} */
	const treeOpen = new Set(['']);
	/** @type {Map<string[], string[]>} */
	const treeKids = new NestedMap();
	const treeTick = $state(0);
	const bumpTree = () => { treeTick.value++; };

	// 纯命令式的临时状态
	let anchor = null;
	/** @type {HTMLElement | null} */
	let ctxEl = null;
	let dragDepth = 0;
	let searchDebounceTimer = 0;

	const sorter = new Intl.Collator('zh-CN', {
		numeric: true
	})

	/* ------------------------------ 派生值 ------------------------------ */
	const sorted = $computed(() => {
		const list = [...entries];
		const key = unconscious(sortKey);
		const dir = unconscious(sortDir);
		return list.sort((a, b) => {
			if (key !== 'size' && (a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;

			let r = 0;
			if (key === 'size') r = (a.size) - (b.size);
			else if (key === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
			if (r === 0) r = sorter.compare(a.name, b.name);
			return r * dir;
		});
	});

	// FIXME this is also a hack
	$watch(sorted, () => {});

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

	const crumbNodes = $computed(() => {
		const parts = unconscious(cwd) ? unconscious(cwd).split('/') : [];
		/** @type {{label: string, target: string, last: boolean}[]} */
		const out = [{label: '根目录', target: '', last: parts.length === 0}];
		parts.forEach((p, i) => out.push({label: p, target: parts.slice(0, i + 1).join('/'), last: i === parts.length - 1}));
		return out;
	});

	/* ------------------------------ 提示 ------------------------------ */
	/**
	 * @param {string} msg
	 * @param {'info'|'ok'|'err'|'warn'} [kind]
	 * @param {number} [ms]
	 */
	const toast = (msg, kind = 'info', ms = 3000) => showToast(<>
		<span className="ic">{TOAST_ICON[kind] || 'i'}</span>
		<span>{msg}</span>
	</>, kind, ms, { dom: toastDiv });

	/* ------------------------------ 列目录 ------------------------------ */
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

	/* ------------------------------ 历史 ------------------------------ */
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

	/* ------------------------------ 路径编辑 ------------------------------ */
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
		const p = normalizePath(pathInput.value).join('/');
		loadDir(p);
	}

	/* ------------------------------ 目录树 ------------------------------ */
	/**
	 * @param {string} path
	 * @param {boolean} [force]
	 * @return {Promise<string[]>}
	 */
	async function loadTreeChildren(path, force = false) {
		const keys = path.split('/');

		let s;
		if (!force && (s = treeKids.get(keys))) return s;

		const dirs = await call('list', {
			path: path || '.', pattern: '*',
			json: true, showDir: 'only',
			limit: 1000
		}).then(list => list.map(x => x[0]), () => []);

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

	/* ------------------------------ 选中 ------------------------------ */
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
	 * @param {{toggle?: boolean, range?: boolean}} [options]
	 */
	function selectRow(path, {toggle = false, range = false} = {}) {
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

	/* ------------------------------ 打开 ------------------------------ */
	/** @param {FileEntry} e */
	const openEntry = e => {
		if (e.type === 'dir') loadDir(e.path);
		else vfsPreview(fs, e.path, e.name, 'auto')
	};

	/* ------------------------------ 右键菜单 ------------------------------ */
	/**
	 * @typedef {{label: string, icon?: JSX.Element, danger?: boolean, disabled?: boolean, act?: Function} | {sep: true}} CtxItem
	 */

	let scrollContainer = ref();

	const closeCtx = () => {
		if (!ctxEl) return;
		ctxEl.remove();
		ctxEl = null;
		document.removeEventListener('mousedown', onDocDown, true);
		scrollContainer.removeEventListener('scroll', closeCtx, true);
	};

	/** @param {MouseEvent} ev */
	function onDocDown(ev) {
		if (ctxEl && !ctxEl.contains(ev.target)) closeCtx();
	}

	/**
	 * @param {number} x
	 * @param {number} y
	 * @param {CtxItem[]} items
	 */
	function showCtx(x, y, items) {
		closeCtx();
		const el = <div className="menu" onClick={ev => {
			const btn = ev.target.closest('button[data-i]');
			if (!btn) return;
			const it = items[+btn.dataset.i];
			closeCtx();
			it?.act?.();
		}}>
			{items.map((it, i) => it.sep ? <hr/> : (
				<button data-i={i} className={it.danger ? 'danger2' : null} disabled={it.disabled}>
					<i className={it.icon} />
					{it.label}
				</button>
			))}
		</div>;
		document.body.appendChild(el);
		const r = el.getBoundingClientRect();
		el.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
		el.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
		ctxEl = el;
		document.addEventListener('mousedown', onDocDown, true);
		scrollContainer.addEventListener('scroll', closeCtx, true);
	}

	/**
	 * @param {MouseEvent} ev
	 * @param {FileEntry} e
	 */
	function onRowMenu(ev, e) {
		ev.preventDefault();
		ev.stopPropagation();

		const targets = selection.value.has(e) ? getSelectedItems() : (selectRow(e), [e]);
		const multi = targets.length > 1;

		const items = [];

		if (!multi) {
			items.push({label: e.type === 'dir' ? '打开' : '预览', icon: e.type === 'dir' ? "ri-folder-line" : "ri-eye-line", act: () => openEntry(e)},);
		}

		items.push(
			{label: '下载', icon: "ri-download-line", act: () => downloadEntries(targets)},
			{sep: true},
			{label: '复制', icon: "ri-file-copy-line", act: () => setClipboard(targets, false)},
			{label: '剪切', icon: "ri-scissors-line", act: () => setClipboard(targets, true)},
		);

		if (!multi) {
			items.push(
				{label: '重命名', icon: "ri-edit-line", act: () => renameEntry(e)},
				{label: '复制路径', icon: "ri-link", act: () => copyWithAnimation(vfsIdentity(fs[FS_SOURCE]) + targets.at(-1).path)},
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

		showCtx(ev.clientX, ev.clientY, items);
	}

	/** 空白处右键 @param {MouseEvent} ev */
	function onBlankMenu(ev) {
		if (entries.error) return;

		ev.preventDefault();
		resetSel();
		showCtx(ev.clientX, ev.clientY, [
			{label: '刷新', icon: "ri-loop-right-line", act: () => $update(cwd)},
			{sep: true},
			{label: '粘贴', icon: "ri-file-copy-line", disabled: !clipboard.value, act: paste},
			{label: '在此处打开终端', icon: "ri-terminal-line", act: terminal},
			{sep: true},
			{label: '上传文件', icon: "ri-upload-line", act: () => fileInput.click()},
			{label: '新建文件夹', icon: "ri-folder-line", act: newFolder},
			{label: '新建文件', icon: "ri-file-line", act: newFile},
		]);
	}

	/* ------------------------------ 剪贴板 ------------------------------ */
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
		let skipSame = 0;
		let skipInner = 0;
		let fail = 0;

		const _cwd = unconscious(cwd);

		let {cut, items, fs: srcFS} = c;

		for (const it of items) {
			a:
			if (srcFS === fs && cut) {
				if (_cwd === parentOf(it.path)) skipSame++;
				else if (_cwd === it.path || _cwd.startsWith(it.path + '/')) skipInner++;
				else break a;
				continue;
			}

			const dest = joinPath(_cwd, resolver(it.name));
			try {
				await vfsCopyMove(srcFS, it.path, fs, dest, cut);
				pasted.push(dest);
				invalidateDirectoryContents(it.path);
				invalidateDirectoryContents(dest);
			} catch (e) {
				fail++;
				toast('粘贴失败：' + it.name + ' — ' + (e.message ?? e), 'err', 5000);
			}
		}

		if (!pasted.length) {
			if (!fail) toast(skipSame ? '目标文件夹和源相同' : '目标文件夹是源文件夹的子文件夹', 'warn');
			return;
		}

		if (cut) clipboard.value = null;

		highlightAfterChange = new Set(pasted);
		$update(cwd);

		if (pasted.length < items.length) toast(`已粘贴 ${pasted.length} / ${items.length} 项`, 'warn');
	}

	function invalidateDirectoryContents(key) {
		if (treeKids.delete(key.split('/'), true)) {
			if (treeOpen.has(key)) loadTreeChildren(key, true);
			else bumpTree();
		}
	}

	/* ------------------------------ 新建 / 改名 / 删除 ------------------------------ */
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
					invalidateDirectoryContents(cwd.value);
				},
				(e) => {
					$update(cwd);
					toast('创建失败：'+(e.message??e), 'err');
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
					toast('创建失败：'+(e.message??e), 'err');
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
				invalidateDirectoryContents(src);
				invalidateDirectoryContents(dest);
			}, (e) => {
				toast('重命名失败：'+(e.message??e), 'err');
				$update(cwd);
			});
		});
	}

	function processNameInput(e, save2, add) {
		if (auxSmallScreen || !sorted.length) {
			SimpleModal({
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
			if (e.type === 'file' && dot > 0) input.setSelectionRange(0, dot);
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

		const dialog = SimpleModal({
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

				let fail = 0;
				let all = items.map(it => call('delete', {path: it.path, recursive: true, force: false}).catch(e => {
					fail++;
					toast('删除失败：' + it.name + ' — ' + e.message, 'err');
				}));
				await Promise.allSettled(all);
				if (fail) toast(items.length > 1 ? `已删除 ${items.length} 项` : `已删除 ${items[0].name}`, 'ok');
				clipboard.value = null;
				$update(cwd);
				treeKids.clear();
				bumpTree();
			}
		});
	}

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

			await vfsDownloadMany(
				fs,
				items,
				baseName(commonPath),
			);
		} catch (err) {
			toast('下载失败：' + (err.message ?? err), 'err');
		}
	}

	/* ------------------------------ 上传 ------------------------------ */

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
		if (f.size && kind === 'api' || kind === 'db') {
			const {base, root, headers} = await call('getUrl');
			p = xhrUpload(f, base+`writeRaw?${root ? "root="+encodeURIComponent(root)+"&" : ''}path=`+encodeURIComponent(target), headers, signal, p => {
				bar.style.width = (p * 100).toFixed(1) + '%';
				pct.textContent = Math.floor(p * 100) + '%';
			})
		} else {
			p = call('writeRaw', { path: target, content: f, signal });
		}

		return p.then(() => {
			toast('上传成功：' + name, 'ok');
		}, (err) => {
			toast('上传失败：' + name + ' — ' + err.message, 'err');
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

	/* ------------------------------ 视图 / 排序 ------------------------------ */
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

	/* ------------------------------ 键盘 ------------------------------ */
	/**
	 * @param {KeyboardEvent} ev
	 */
	function onGlobalKey(ev) {
		if (document.elementFromPoint(0,0).matches('dialog.modal')) return;

		const tag = (ev.target.tagName || '').toLowerCase();
		const typing = (tag === 'input' && ev.target.type !== 'checkbox') || tag === 'textarea' || ev.target.isContentEditable;
		const meta = ev.ctrlKey || ev.metaKey;
		const key = ev.key.toLowerCase();

		if (meta) {
			if (key === 'l') {
				ev.preventDefault();
				startPathEdit();
				return;
			}
			if (key === 'r') {
				ev.preventDefault();
				$update(cwd);
				return;
			}
			if (key === 'f') {
				ev.preventDefault();
				searchInput.focus();
				return;
			}
		}

		if (typing) return;

		if (ev.key === 'Backspace') {
			ev.preventDefault();
			goUp();
			return;
		}
		if (ev.key === '/') {
			ev.preventDefault();
			searchInput.focus();
			return;
		}

		const firstItem = selection.value.keys().next().value;
		const selectedCount = selection.value.size;
		if (ev.key === 'F2' && selectedCount === 1) {
			ev.preventDefault();
			renameEntry(firstItem);
			return;
		}
		if (ev.key === 'Delete' && selectedCount) {
			ev.preventDefault();
			deleteEntries(getSelectedItems());
			return;
		}

		if (meta) {
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

		if (ev.key === 'Enter' && selectedCount === 1) {
			const e = entries.value.find(x => x === firstItem);
			if (e) openEntry(e);
		}

		if (!sorted.length) return;

		if (ev.key === 'ArrowDown') {
			if (selectedCount === 1) {
				selectRow(sorted[sorted.indexOf(firstItem)+1] ?? sorted[0]);
			} else if (selectedCount === 0) {
				selectRow(sorted[0]);
			} else {
				let last;
				selection.value.forEach(i => last = i);
				selectRow(last);
			}
			return;
		}

		if (ev.key === 'ArrowUp') {
			if (selectedCount === 1) {
				selectRow(sorted.at(sorted.indexOf(firstItem)-1));
			} else if (selectedCount === 0) {
				selectRow(sorted.at(-1));
			} else {
				selectRow(firstItem);
			}
		}
	}

	/* ------------------------------ 行 / 空状态 ------------------------------ */
	/**
	 * @param {FileEntry} e
	 * @return {JSX.Element}
	 */
	function makeRow(e) {
		const isDir = e.type === 'dir';
		let icon;

		if (isDir) {
			icon = <span className="ico ri-folder-fill" />;
		} else {
			const iconClass = iconClassOf(extOf(e.name));
			icon = <span className={"ico "+iconClass} style={`color:${iconColorOf(iconClass)}`} />
		}

		return <div className="row"
					class:sel={() => selection.has(e)}
					class:cut={() => cutPaths.has(e.path)}
					onClick={ev => {
						if (ev.target.nodeName === "INPUT") return;
						selectRow(e, {toggle: ev.ctrlKey || ev.metaKey, range: ev.shiftKey});
					}}
					onDblClick={ev => {
						if (ev.target.closest('.chk')) return;
						openEntry(e);
						clearTimeout(e.timer);
					}}
					onContextMenu={ev => onRowMenu(ev, e)}>
			<div className="chk">
				<input type="checkbox" tabIndex={-1}
					   checked={() => selection.has(e)}
					   onChange={() => toggleSel(e)}/>
			</div>
			<div className="name" onClick={ev => {
				if (!auxMainlyTouch && !e.edit && selection.has(e) && selection.size === 1) {
					clearTimeout(e.timer);
					e.timer = setTimeout(() => {
						if (selection.has(e) && selection.size === 1) {
							renameEntry(e);
						}
					}, 500);
				}
			}}>
				{icon}
				{e.edit ?? <span className="ellipsis" title={e.name}>{e.name}</span>
			}
		</div>
		<div className="time">{formatDate('Y-m-d H:i', e.mtime)}</div>
			<div className={'size'}>{isDir ? '' : formatSize(e.size)}</div>
		</div>;
	}

	/* ------------------------------ 元素 ------------------------------ */
	const pathInput = <input placeholder="输入路径，例如 Documents/项目 或 /" spellCheck={false}
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

	const searchInput = <input className="text-input"  placeholder="搜索文件名" spellCheck={false}
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
		<div className="sidebar2 col">
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
			<div className="hab">
				<div className="row">
					<div className="dropdown">
						<button className="ri-upload-line btn ghost" onClick={() => {
							if (auxMainlyTouch) return;
							fileInput.click()
						}}>上传
						</button>
						<div className="list mid up">
							{IS_ANDROID_BUILD && <label className="ri-camera-4-fill" onClick={() => {webviewUploadImage().then(b => uploadFiles([b]))}}>拍摄照片</label>}
							<label className="ri-mic-fill" role="button" tabIndex={0} onClick={() => {openRecorder().then(b => uploadFiles([b]), () => {})}}>录制语音</label>
							<label className="ri-attachment-2" role="button" tabIndex={0} onClick={() => fileInput.click()}>选择文件</label>
						</div>
					</div>
					<button ref={terminalBtn} className="ri-terminal-line btn ghost" onClick={terminal}>终端</button>
				</div>
			</div>
		</div>

		<main className="col">
			<div className="toolbar">
				<button className="ri-arrow-left-s-line tbtn" title="后退" disabled={() => unconscious(historyIndex) === 0} onClick={goBack}/>
				<button className="ri-arrow-right-s-line tbtn" title="前进" disabled={() => unconscious(historyIndex) >= historyStack.length - 1} onClick={goForward}/>
				<button className="ri-arrow-up-line tbtn" title="返回上级" disabled={() => !cwd.value} onClick={goUp}/>

				<div className="crumbs" onDblClick={startPathEdit}>
				<span style:display={() => editingPath.value ? 'none' : 'contents'}>
					{$foreach(crumbNodes, c => {
						const btn = <button className={'crumb' + (c.last ? ' last' : '')} title={c.target || '/'}
											onClick={() => {
												if (c.target !== cwd.value) loadDir(c.target);
											}}>{c.label}</button>;
						if (c.last) setTimeout(() => btn.scrollIntoView({inline: 'end', block: 'nearest'}), 0);
						return <span style="display:contents">{btn}{c.last ? null : <span className="sep">/</span>}</span>;
					}, JSON.stringify)}
				</span>
					{pathInput}
				</div>
				<button style="border-right: 1px solid var(--border);" className="ri-loop-right-line icon-btn" title="刷新" onClick={() => $update(cwd)} />
				<div className="fa-search"><Icon_search/>{searchInput}</div>
			</div>

			<div className="head">
				<div>{chkAll}</div>
				<div className="sortable" class:on={() => sortKey.value === 'name'} onClick={() => sortBy('name')}>
					名称 <span className="arrow">{() => arrowOf('name')}</span>
				</div>
				<div className="sortable r time" class:on={() => sortKey.value === 'mtime'} onClick={() => sortBy('mtime')}>
					修改时间 <span className="arrow">{() => arrowOf('mtime')}</span>
				</div>
				<div className="sortable r" class:on={() => sortKey.value === 'size'} onClick={() => sortBy('size')}>
					大小 <span className="arrow">{() => arrowOf('size')}</span>
				</div>
			</div>

			<div ref={scrollContainer} className="list scroll" onClick={e => {
				if (!e.target.closest('.row')) resetSel();
			}} onContextMenu={onBlankMenu}>
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
								if (e.type !== 'file') {
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

		<div className="dropMask" class:on={dropActive}>
			<div className="box">
				<b>释放以上传</b>
				<span>{() => cwd.value || '/'}</span>
			</div>
		</div>

		<div className="uploads" ref={uploadDiv} />
		<div className="win-toasts" ref={toastDiv} />
	</div>;

	/* ------------------------------ 启动 ------------------------------ */

	$cleanup(body, EVENT_BUS.onoff('fileChanged', (fs1, _, path) => {
		if (fs1 === fs) {
			const dir = unconscious(cwd);
			const pathParent = parentOf(path);
			invalidateDirectoryContents(pathParent);
			if (dir === path || dir === pathParent) {
				highlightAfterChange = new Set([...selection].map(e => e.path));
				$update(cwd);
			}
		}
	}));

	body.navigateTo = loadDir;
	return {
		element: body,
		onFocus(isFocused) {
			if (isFocused) document.addEventListener('keydown', onGlobalKey);
			else document.removeEventListener('keydown', onGlobalKey)
		}
	};
};