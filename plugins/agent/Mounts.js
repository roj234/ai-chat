import {IndexedDBAccess} from "/src/utils/dbAccess.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {prettyError, updateOnIntersected} from "/src/utils/utils.js";
import {SETTINGS} from "/src/settings.js";
import {config} from "/src/states.js";
import {showToast} from "/src/components/Toast.js";
import {createWebFileSystem} from "./WebFSDriver.js";
import {createConfigFileSystem} from "./ConfigFileSystem.js";
import {NAMED_VFS} from "./VirtualFileSystem.js";
import {$computed, $foreach, $forElse, $state, $update, debugSymbol, ONCE_EVENT, unconscious} from "unconscious";
import {formatSize, immutableObjectMap, prettyTime} from "unconscious/common/Utils.js";
import {isIDB, kvListDel, kvListGet, kvListGetValues, kvListSet} from "/src/database.js";
import "./Mounts.css";
import {FSE_NotAllowed, FSE_NotFound, FSE_NotSupported, PROMISE_CATCH, throwDOMException} from "/common/pure-utils.js";
import {CREATE_OPT, resolveDirectory} from "./WebFSUtils.js";
import {addRemoteFileSystem, BACKEND_SERVER_KVLIST_ID, createRemoteFileSystem} from "./RemoteFSDriver.js";
import {Icon_search, Icon_warning} from "/src/components/Icons.jsx";

/** @type {Map<string, {
 * handle: FileSystemDirectoryHandle,
 * fss: Map<string, AiChat.FileSystemInstance>
 }>} */
const localFileSystemCache = new Map;

const FOLDER_STORE_NAME = 'folders';

const [folderDB, deleteDatabase] = IndexedDBAccess(APP_NAME+":fileAccess", 3, (event) => {
	/** @type {IDBDatabase} */
	const db = event.target.result;
	if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) db.createObjectStore(FOLDER_STORE_NAME, { keyPath: 'name' });

	const API_STORE_NAME = 'servers';
	if (db.objectStoreNames.contains(API_STORE_NAME)) db.deleteObjectStore(API_STORE_NAME);
});

const directoryPicker = window.showDirectoryPicker;



const FS_OPENING = debugSymbol("FS_OPENING");
export const FS_INSTANCE = debugSymbol("FileSystem");



const ICONS = immutableObjectMap({
	db: "ri-cloud-fill",
	config: "ri-brackets-line",
	opfs: "ri-chrome-fill",
	[BACKEND_SERVER_KVLIST_ID]: "ri-box-3-line",
	local: "ri-folder-open-line",
	dir: "ri-folder-open-line",
	new: "ri-folder-add-line"
});

const MODIFIABLE_ROLE = immutableObjectMap({
	[BACKEND_SERVER_KVLIST_ID]: true,
	local: true
});



/**
 * 实例化文件系统
 * @param {AiChat.Mount} mount
 * @return {Promise<AiChat.FileSystemInstance>}
 */
const materializeFileSystem = async (mount) => {
	let {fs_type, fs_base} = mount;
	switch (fs_type) {
		case "db": {
			return createRemoteFileSystem(config.db_server + 'fs/', config.db_pat, fs_base);
		}
		case "api": {
			let {uri, pat} = await kvListGet(BACKEND_SERVER_KVLIST_ID, mount.fs_server);
			return createRemoteFileSystem(uri + 'fs/', pat, fs_base);
		}
		case "local": {
			const paths = fs_base?.split("/") || [];
			const base = paths.shift();

			let inst = localFileSystemCache.get(base);
			if (!inst) {
				const folder = await folderDB((tx) => tx.objectStore(FOLDER_STORE_NAME).get(base), false, FOLDER_STORE_NAME);
				if (folder) {
					const handle = folder.handle;
					while (true) {
						let result;
						try {
							result = await handle.requestPermission({mode: 'readwrite'});
						} catch (e) {
							if (e.message.includes('User activation')) {
								await new Promise((resolve) => {
									const div = <div style={"position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none"}>
										<div style={"background:var(--bg);color:var(--text);padding:1%"}>点击页面任意位置，连接本地文件系统喵~</div>
									</div>;
									const body = document.body;
									body.append(div);
									body.addEventListener("click", e => {
										div.remove();
										resolve();
									}, ONCE_EVENT);
								});
								continue;
							}

							throw e;
						}

						if (result !== "granted") throwDOMException("你拒绝了权限请求", FSE_NotAllowed);
						break;
					}

					await (await handle.entries()).next();
					localFileSystemCache.set(folder.name, inst = {handle, fss: new Map});
				} else {
					throwDOMException("文件路径 "+base+" 不存在", FSE_NotFound);
				}
			}

			const key = JSON.stringify([fs_base, mount.fs_ACL]);
			let fs = inst.fss.get(key);
			if (!fs) inst.fss.set(key, fs = await createWebFileSystem(await resolveDirectory(inst.handle, paths), mount));
			return fs;
		}
		case "opfs": {
			let baseDir = await navigator.storage.getDirectory();
			if (fs_base) baseDir = await resolveDirectory(baseDir, fs_base, CREATE_OPT);
			return createWebFileSystem(baseDir, mount);
		}
		case "config":
			return createConfigFileSystem(fs_base, mount);
		case "vfs":
			const vd = NAMED_VFS[fs_base];
			if (!vd) throwDOMException("找不到虚拟文件系统实例 "+fs_base, FSE_NotFound);
			return createWebFileSystem(vd, mount);
	}
};

/**
 * 调用 File Browser Interface (FBI) 选择文件系统实现
 * 这绝对不是我瞎编的接口！
 * @param {AiChat.Mount} mount
 * @return {Promise<AiChat.FileSystemInstance>}
 */
async function callFBI(mount) {
	if (config.fs_autoMount && mount.fs_builtin) {
		if (!isIDB) {
			// 有云端就用云端
			mount.fs_type = 'db';
		} else if (directoryPicker) {
			// 否则使用文件夹名称
			mount.fs_type = 'local';
		} else {
			// 否则回退到 OPFS
			mount.fs_type = 'opfs';
		}
	}

	let fsError;
	if (mount.fs_type) try {
		return await materializeFileSystem(mount);
	} catch (e) {
		fsError = e;
	}

	const rootItems = [
		...await kvListGetValues(BACKEND_SERVER_KVLIST_ID),
		...await folderDB((tx, resolve) => {
			const request = tx.objectStore(FOLDER_STORE_NAME).getAll();
			request.onsuccess = (event) => {
				const result = event.target.result;
				result.forEach(item => item.type = "local");
				return resolve(result);
			};
		}, false, FOLDER_STORE_NAME),
		...(!isIDB ? [{name: "典藏", el: <span className={"desc ellipsis"}>技能行于云端，多端同步如一。</span>, type: "db", lastAccessed: 0}] : []),
		{name: "化卷", el: <span className={"desc ellipsis"}>映射内部数据为虚拟目录。<br/><b
				style={"color:var(--error)"}>注意数据安全！</b></span>, type: "config", lastAccessed: 0 },
		{name: "暗渊", el: <span className={"desc ellipsis"}>藏于浏览器私库 (OPFS)，亦可导出。</span>, type: "opfs", lastAccessed: 0},
	];
	const pathStack = $state([]);

	const resort = () => rootItems.sort((a, b) => {
		if ((a.pinned | 0) !== (b.pinned | 0)) return b.pinned ? 1 : -1;
		return b.lastAccessed - a.lastAccessed;
	})

	await new Promise((resolve, reject) => {
		const itemTree = $state(resort());
		const filterText = $state("");
		const displayItems = $computed(() => {
			const items = unconscious(itemTree);
			const filter = unconscious(filterText);
			return filter ? items.filter(s => s.name.toLowerCase().includes(filter)) : items;
		}, null, true);
		const activeItem = $state();

		/**
		 * @typedef {{
		 *     pinned?: number,
		 *     name: string,
		 *     type: string,
		 *     lastAccess?: number,
		 *
		 *     uri?: string,
		 *     pat?: string,
		 *
		 *     handle?: FileSystemDirectoryHandle
		 * }} FileAbstraction
		 */

		/**
		 *
		 * @param {HTMLElement} btn
		 * @param {FileAbstraction} item
		 * @return {Promise<void>}
		 */
		const pinItem = (btn, item) => {
			const pinnedNow = item.pinned ^= true;
			btn.className = pinnedNow ? "ri-pushpin-fill" : "ri-pushpin-line";
			btn.title = pinnedNow ? '取消置顶' : '置顶';

			resort();
			$update(itemTree);
			saveItem(item);
		};
		/**
		 *
		 * @param {FileAbstraction} item
		 * @return {Promise<void>}
		 */
		const saveItem = item => {
			let p;
			if (item.type === BACKEND_SERVER_KVLIST_ID) {
				p = kvListSet(item, BACKEND_SERVER_KVLIST_ID);
			} else if (item.type === "local") {
				const { type, ...rest } = item;
				p = folderDB((tx) => tx.objectStore(FOLDER_STORE_NAME).put(rest), true, FOLDER_STORE_NAME);
			}

			return p;
		};
		/**
		 *
		 * @param {HTMLElement} btn
		 * @param {FileAbstraction} item
		 * @return {Promise<void>}
		 */
		const deleteItem = (btn, item) => {
			const onDeleted = () => {
				const i = rootItems.indexOf(item);
				if (i >= 0) {
					if (unconscious(activeItem) === item)
						activeItem.value = null;

					rootItems.splice(i, 1);

					const listItem = btn.closest("li");
					listItem.classList.add('item-removing');
					setTimeout($update, 180, itemTree);
				}
			};

			let p;
			if (item.type === BACKEND_SERVER_KVLIST_ID) {
				p = kvListDel(BACKEND_SERVER_KVLIST_ID, item.name);
			} else if (item.type === "local") {
				p = folderDB((tx) => tx.objectStore(FOLDER_STORE_NAME).delete(item.name), true, FOLDER_STORE_NAME);
			}

			btn.disabled = true;
			return p.then(onDeleted).finally(() => btn.disabled = false);
		};
		/**
		 *
		 * @param {FileAbstraction} item
		 * @return {Promise<void>}
		 */
		const editItem = (item) => {
			const defaultChoice = (item.handle?.name || item.uri);
			SimpleModal({
				title: "修改显示名称",
				type: "input",
				placeholder: defaultChoice,
				onConfirm(name) {
					const i = rootItems.indexOf(item);
					if (item.type === BACKEND_SERVER_KVLIST_ID) {
						kvListDel(BACKEND_SERVER_KVLIST_ID, item.name);
					} else {
						folderDB((tx) => tx.objectStore(FOLDER_STORE_NAME).delete(item.name), true, FOLDER_STORE_NAME);
					}
					saveItem(itemTree[i] = {...item, name: name || defaultChoice});
				}
			});
		};
		/**
		 *
		 * @param {HTMLElement} el
		 * @param {FileAbstraction} item
		 * @return {Promise<boolean>}
		 */
		const initFileSystem = async (el, item) => {
			const fsType = item.type;

			delete mount.fs_server;
			delete mount[FS_INSTANCE];
			mount.fs_type = fsType;
			mount.fs_base = "";

			if (fsType === "local") {
				const result = await item.handle.requestPermission({mode: 'readwrite'});
				if (result !== "granted") return;
				mount.fs_base = item.name;
				await (await item.handle.entries()).next();
			} else {
				if (fsType === BACKEND_SERVER_KVLIST_ID) {
					mount.fs_type = "api";
					mount.fs_server = item.name;
				}
			}

			const listItem = el.closest('li');
			try {
				mount[FS_INSTANCE] = await materializeFileSystem(mount);
			} catch (e) {
				showToast(prettyError(e), 'error');
				listItem.classList.add("error");
				return;
			}

			return true;
		}
		/**
		 *
		 * @param {HTMLElement} el
		 * @param {FileAbstraction} [item]
		 * @return {Promise<void>}
		 */
		const enterDir_doubleClick = (el, item = {}) => (async () => {
			if (unconscious(itemTree) === rootItems) {
				if (!await initFileSystem(el, item)) return;
				const s = new String("根");
				s._root = item;
				pathStack.push(s);
				pathStack.push(item.name);
			}

			const fsType = item.type;
			if (fsType === "back") pathStack.pop();
			if (fsType === "dir") pathStack.push(item.name);
			if (fsType === "new") return;

			let arr;
			if (pathStack.length < 2) {
				pathStack.length = 0;
				arr = rootItems;
			} else {
				let entries = await callFileSystemFunc(mount[FS_INSTANCE], "list", {
					path: pathStack.slice(2).join('/'),
					showDir: true,
					showModified: true,
					showHidden: true,
					json: true,
				});

				arr = [];

				for (const [name, type, size, lastModified] of entries) {
					if (type === "dir") {
						arr.push({
							type: "dir",
							name,
							lastAccessed: lastModified
						})
					}
				}

				const intl = new Intl.Collator;
				arr.sort((a, b) => {
					const nameB = b.name;
					const nameA = a.name;

					const numA = nameA | 0;
					const numB = nameB | 0;
					if (numA && numB) return numA - numB;

					return intl.compare(nameA, nameB);
				});
			}

			filterText.value = "";
			itemTree.value = arr;
			activeItem.value = null;
		})().catch(e => {
			if (unconscious(itemTree) === rootItems) pathStack.length = 0;
			else if (item.type === "dir") pathStack.pop();

			showToast(prettyError(e), 'error');
			if (el) el.closest("li").classList.add("error");
		})
		/**
		 *
		 * @param {HTMLElement} el
		 * @param {FileAbstraction} item
		 * @return {Promise<void>}
		 */
		const highlightDir_click = async (el, item) => {
			const fsType = item.type;
			if (fsType === "new") return;

			if (el) {
				const listItem = el.closest('li');
				if (!listItem.classList.contains("active")) {
					listItem.parentElement.querySelector(".active")?.classList.remove("active");
					listItem.classList.add("active");
					activeItem.value = listItem;
				}
			}
		}
		const selectDir = async () => {
			let el = unconscious(activeItem);
			let item = el._item;

			if (unconscious(itemTree) === rootItems) {
				if (!await initFileSystem(el, item)) return;
			} else {
				const dirName = item.name;
				item = pathStack[0]._root;
				delete mount[FS_INSTANCE];
				mount.fs_base = [...pathStack.slice(item.type === "local" ? 1 : 2), dirName].join('/');
			}

			item.lastAccessed = Date.now();
			await saveItem(item);

			modal.remove();
			resolve(item);
		};

		const modal = <dialog className="modal fa-modal" role="dialog" aria-modal="true">
			<div>
				<div style={"display:flex"}>
					{mount.fs_label || ("挂载" + (mount.fs_name || "工作区"))}
					<span className={"spacer"}></span>
					<button className="ri-close-line btn sm danger" title={"关闭窗口"} onClick={() => {
						modal.remove();
						reject(fsError?.message ?? fsError ?? "未选择文件系统");
					}}/>
				</div>
				{fsError && <div className="fa-alert row">
					<div className="row">
						<Icon_warning/>
						<div className="col">
							<b>未能重新连接上次的工作区</b>
							<span className="desc">{fsError.message ?? fsError}</span>
						</div>
					</div>
					<button className="btn" onClick={() => {
						modal.remove();
						resolve(callFBI(mount));
					}}>重试
					</button>
				</div>}
				<div className="fa-search">
					<Icon_search />
					<input type="text" className="text-input" placeholder="筛选" autoComplete="off"
						   value={filterText} onInput={({target}) => {
						filterText.value = target.value.toLowerCase();
					}}/>
				</div>

				<div className="tabs">
					<div className={"tabs"} style:display={() => unconscious(itemTree) !== rootItems ? "none" : ""}>
						{directoryPicker && <button className="btn ghost" onClick={() => {
							directoryPicker({
								id: APP_NAME + "_agent_root",
								mode: "readwrite"
							}).then(async handle => {
								let displayName = handle.name;
								const duplicate = !displayName || rootItems.some(item => item.type === "local" && item.name === displayName);
								displayName = await new Promise(resolve => {
									SimpleModal({
										title: `为文件夹 ${displayName} 设置别名`+(duplicate?"":" (可选)"),
										type: "input",
										placeholder: "覆盖默认的名称，便于查找（防止重名）",
										onConfirm(value) {
											if (!value) return false;
											resolve(value || displayName);
										},
										onCancel: duplicate ? null : () => resolve(displayName)
									})
								});

								const def = {
									name: displayName,
									handle,
									lastAccessed: Date.now(),
								};

								return folderDB((tx) => (
									tx.objectStore(FOLDER_STORE_NAME).put(def)
								), true, FOLDER_STORE_NAME).then(() => itemTree.unshift({
									type: "local",
									...def
								}))
							}, PROMISE_CATCH);
						}}>
							添加本地
						</button>}
						<button className="btn ghost" onClick={() => addRemoteFileSystem().then((def) => (
							itemTree.unshift(def)
						), PROMISE_CATCH)}>添加容器
						</button>
					</div>
					<div className={"tabs"} style:display={() => unconscious(itemTree) === rootItems ? "none" : ""}>
						<span className={"paths"}>{$foreach(pathStack, (item, i) => <span onClick={() => {
							pathStack.length = i + 1;
							enterDir_doubleClick(null);
						}}>{item}</span>)}</span>
						<span className={"spacer"}></span>
						<button className="btn ghost" onClick={() => {
							let input = <input className={"text-input"} placeholder={"名称"}/>;
							itemTree.unshift({
								type: "new",
								el: <>
									{input}
									<button className={"btn ghost"} onClick={async () => {
										const value = input.value;
										if (value) {
											await callFileSystemFunc(mount[FS_INSTANCE], "mkdir", {
												path: pathStack.slice(2).join('/')+'/'+ value
											});
											activeItem.value = null;
											return enterDir_doubleClick();
										}
									}}>√</button>
									<button className={"btn ghost"} onClick={() => enterDir_doubleClick()}>×</button>
								</>
							})
						}}>新建
						</button>
					</div>
					<span className={"spacer"} />
					<button className="btn primary" disabled={() => !unconscious(activeItem)} onClick={selectDir}>选择</button>
				</div>
			</div>

			<div className="list" role="list" class:xl={() => unconscious(itemTree) === rootItems}>
				{$forElse(displayItems, item => {
					return <li
						onDblClick={e => enterDir_doubleClick(e.target, item)}
						onClick={e => highlightDir_click(e.target, item)}
						role="listitem"
						tabIndex={0}
						_item={item}
					>
						<div className="left">
							<div className={"icon "+ICONS[item.type]} />
							<div className="info">
								<div className="title">
									<span>{item.name}</span>{item.el}
									{(unconscious(itemTree) === rootItems) &&
										<span className={item.pinned ? "ri-pushpin-fill" : "ri-pushpin-line"}
											  title={item.pinned ? '取消置顶' : '置顶'}
											  onClick.stop={e => pinItem(e.target, item)}/>}
								</div>
								{item.lastAccessed && <div className="desc">上次使用: {prettyTime(item.lastAccessed)}</div>}
							</div>
						</div>

						{MODIFIABLE_ROLE[item.type] && <div className="buttons">
							<button className="ri-edit-box-line btn1" title="编辑"
									onClick.stop={() => editItem(item)}/>
							<button className="ri-delete-bin-line btn1 delete" title="删除"
									onClick.stop={(e) => deleteItem(e.target, item)}/>
						</div>}
					</li>
				}, <div className="empty">没有匹配的记录</div>)}
			</div>
		</dialog>;

		document.body.append(modal);
		modal.showModal();
	});
	return materializeFileSystem(mount);
}

/**
 * 根据配置初始化文件系统
 * @param {AiChat.Mount} mount
 * @return {Promise<AiChat.FileSystemInstance>}
 */
export const createFileSystem = (mount) => {
	let fs = mount[FS_INSTANCE];
	if (fs) return fs;

	let promise = mount[FS_OPENING];
	if (!promise) {
		promise = mount[FS_OPENING] = callFBI(mount);
		promise.then(fs => mount[FS_INSTANCE] = fs);
		promise.finally(() => {delete mount[FS_OPENING];});
	}
	return promise;
};

/**
 *
 * @param {AiChat.Mount} mount
 * @param {Promise<AiChat.FileSystemInstance>} promise
 */
export const createFileSystemAsync = (mount, promise) => {
	mount[FS_OPENING] = promise;
	promise.then(fs => mount[FS_INSTANCE] = fs);
	promise.finally(() => {delete mount[FS_OPENING];});
}

/**
 * 调用文件系统功能
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} func
 * @param {Record<String, any>} parameters
 * @param {AiChat.Conversation} [conv]
 * @return {Promise<string>}
 */
export const callFileSystemFunc = (fs, func, parameters, conv) => {
	if (typeof fs === 'function') return fs(func, parameters, conv);

	const handler = fs[func];
	if (!handler) throwDOMException(`${func} is not implemented in this VFS`, FSE_NotSupported);
	return handler(parameters);
};

/**
 * 根据路径选择文件系统
 * @param {string} path
 * @param {AiChat.Conversation} conv
 * @returns {Promise<[string, AiChat.FileSystemInstance, AiChat.Mount]>}
 */
export const getFileSystem = async (path, conv) => {
	if (path) {
		if (path.startsWith("~/")) {
			let end = path.indexOf('/', 2);
			const mountPoint = conv.mnt?.[path.slice(2, end < 0 ? path.length : end)];
			if (!mountPoint) throwDOMException(`Mount ${JSON.stringify(path)}`, FSE_NotFound);
			return [end < 0 ? "" :path.slice(end+1), await createFileSystem(mountPoint), mountPoint];
		}
		if (path[0] === '/') throwDOMException("Absolute path is not allowed, it is confusing when interacting with multiple VFSs", FSE_NotAllowed);
	}
	const myfs = await createFileSystem(conv);
	return [path, myfs, conv];
};

const writeTools = new Set(["write", "patch", "edit", "delete", "append", "mkdir", "writeRaw", "appendRaw"]);
const keys = ["path", "cwd", "pattern"];
/**
 * AI工具包装器
 * @param {string} func
 * @return {function(Record<string, any>, AiChat.ToolResponse, AiChat.Conversation): Promise<string>}
 */
export const fileAccess = (func) => async (parameters, _, conv) => {
	// This is Global not per-fs alert
	if (conv.fs_readonly && writeTools.has(func)) throwDOMException("Write-protect is enabled globally", "ReadOnlyError");

	let path, key;
	for (let i = 0; i < keys.length; i++) {
		key = keys[i];
		if ((path = parameters[key])) break;
	}

	let [newPath, fs, mnt] = await getFileSystem(path, conv);

	if (mnt.fs_readonly && writeTools.has(func)) throwDOMException("Write-protect is enabled for this VFS", "ReadOnlyError");

	if (newPath !== path) {
		parameters = { ...parameters };
		parameters[key] = newPath;
	}

	return callFileSystemFunc(fs, func, parameters, conv);
};

// UI

const state = $state();
const updateEstimate = () => navigator.storage.estimate().then(t => state.value = formatSize(t.usage) + "/" + formatSize(t.quota));
const opfsDialog = <div className={"choice-scroll"}>
	<button className={"btn ghost"} onClick={() => callFBI({ fs_label: "管理文件系统" }).catch(PROMISE_CATCH)}>管理文件系统</button>
	<button className={"btn danger"} onClick={() => {
		SimpleModal({
			title: "清空私库（OPFS）？",
			message: "这包括:\n源私有文件系统（藏渊）中的所有数据\n申请了存储权限的插件数据\n\n重要数据请提前打包导出",
			async onConfirm() {
				const dir = await navigator.storage.getDirectory();
				for await (const [name] of dir.entries()) {
					await dir.removeEntry(name, {recursive: true});
				}
				updateEstimate();
			}
		})
	}}>清空私库
	</button>
	<small>已用：{state}</small>
</div>;

updateOnIntersected(opfsDialog, updateEstimate);

SETTINGS.push({
	_tab: "tools",
	type: "element",
	element: opfsDialog
}, {
	id: "fs_autoMount",
	_tab: "tools",
	name: "自动映射内置挂载点",
	title: "仅影响新对话，开启后技能/记忆等内置挂载点将是全局的",
	type: "radio",
	required: true,
	choices: {
		'自动映射': true,
		'手动选择': false,
	}
});
