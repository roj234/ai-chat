import {IndexedDBAccess} from "/src/utils/dbAccess.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {prettyError, updateOnIntersected} from "/src/utils/utils.js";
import {SETTINGS} from "/src/settings.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {config, EVENT_BUS, selectedConversation} from "/src/states.js";
import {showToast} from "/src/components/Toast.js";
import {createWebFileSystem, resolveDirectory} from "./WebFileSystem.js";
import {createConfigFileSystem, createVirtualFileSystem} from "./VirtualFileSystem.js";
import {ContentPart, getToolParameters} from "/src/toolset.js";
import {jsonFetch} from "/common/openai-api-utils.js";
import {$state, debugSymbol, unconscious} from "unconscious";
import {formatSize} from "unconscious/common/Utils.js";
import {getMessagesCacheFirst, isIDB} from "/src/database.js";
import {SHA256} from "unconscious/common/SHA256.js";
import "./fileAccess.css";
import {normalizePath} from "unconscious/common/path-utils.js";

/** @type {Map<string, {
 * handle: FileSystemDirectoryHandle,
 * fs: AiChat.FileSystemInstance
 }>} */
const webFileSystemInstances = new Map;

const LOCAL_STORE_NAME = 'folders';
const API_STORE_NAME = 'servers';
const MAX_FOLDERS = 10;

const [transaction, deleteDatabase] = IndexedDBAccess(APP_NAME+":fileAccess", 2, (event) => {
	const db = event.target.result;
	if (!db.objectStoreNames.contains(LOCAL_STORE_NAME)) db.createObjectStore(LOCAL_STORE_NAME, { keyPath: 'name' });
	if (!db.objectStoreNames.contains(API_STORE_NAME)) db.createObjectStore(API_STORE_NAME, { keyPath: 'uri' });
});


const NEWLY_CREATED_FILES = debugSymbol("WrittenFiles");

export const MarkAsChangeable = new Set(['Read', 'Write', 'Edit', 'Patch']);

/**
 * @param {AiChat.Conversation} conv
 * @param {string} [path]
 * @return {Promise<*>}
 */
export async function getChangeableFiles(conv, path) {
	let files = conv[NEWLY_CREATED_FILES];
	if (!files) {
		if (path) return;

		files = conv[NEWLY_CREATED_FILES] = new Set;
		for (const message of await getMessagesCacheFirst(conv)) {
			const resp = message.tool_responses;
			if (resp) {
				for (let i = 0; i < resp.length; i++) {
					const k = message.tool_calls[i], v = resp[i];
					if (v.success && MarkAsChangeable.has(k.function.name)) {
						const tp = getToolParameters(v, k, true);
						if (tp) files.add(tp.path);
					}
				}
			}
		}
	} else if (path) {
		files.add(path);
	}
	return files;
}

EVENT_BUS.on(['conversation', 'branch'], (e) => {
	const conv = e[0];
	delete conv[NEWLY_CREATED_FILES];
})

/**
 *
 * @returns {Promise<{name: string, handle: FileSystemDirectoryHandle, lastAccessed: number}[]>}
 */
const listFolders = () => {
	return transaction((tx, resolve) => {
		const request = tx.objectStore(LOCAL_STORE_NAME).getAll();
		request.onsuccess = (event) => resolve(event.target.result.sort((a, b) => b.lastAccessed - a.lastAccessed));
	}, false, LOCAL_STORE_NAME);
};
/**
 * 新增或更新文件夹记录
 * @param {FileSystemDirectoryHandle} handle
 * @param {string} name
 */
const upsertFolder = (handle, name) => transaction((tx) => {
	tx.objectStore(LOCAL_STORE_NAME).put({
		name: name || handle.name,
		handle,
		lastAccessed: Date.now(),
	});
	listFolders().then(folders => {
		folders.splice(MAX_FOLDERS).forEach(item => deleteFolder(item))
	})
}, true, LOCAL_STORE_NAME);
/**
 * 删除文件夹记录
 * @param {string} name
 */
const deleteFolder = (name) => transaction((tx) => tx.objectStore(LOCAL_STORE_NAME).delete(name), true, LOCAL_STORE_NAME);

/** @returns {Promise<{uri: string, lastAccessed: number}[]>} */
const listApiServers = () => transaction((tx, resolve) => {
	const request = tx.objectStore(API_STORE_NAME).getAll();
	request.onsuccess = event => resolve(event.target.result.sort((a, b) => b.lastAccessed - a.lastAccessed));
}, false, API_STORE_NAME);

/** @param {string} uri */
const upsertApiServer = uri => transaction(tx => {
	tx.objectStore(API_STORE_NAME).put({uri, lastAccessed: Date.now()});
	listApiServers().then(servers => servers.splice(MAX_FOLDERS).forEach(item => deleteApiServer(item.uri)));
}, true, API_STORE_NAME);

/** @param {string} uri */
const deleteApiServer = uri => transaction(tx => tx.objectStore(API_STORE_NAME).delete(uri), true, API_STORE_NAME);

const directoryPickerAvailable = window.showDirectoryPicker;

const FS_OPENING = debugSymbol("FS_OPENING");
export const FS_INSTANCE = debugSymbol("FileSystem");

async function initializeWebFileSystem(fs) {
	if (!fs.fs) {
		try {
			await fs.handle.requestPermission({mode: 'readwrite'});
		} catch (e) {
			if (e.message.includes('User activation')) {
				await new Promise((resolve) => {
					SimpleModal({
						title: "需要用户交互",
						message: "请点击确认激活文件系统",
						onConfirm: resolve,
						onCancel: null
					})
				});
				return initializeWebFileSystem(fs);
			}
		}
		fs.fs = createWebFileSystem(fs.handle, unconscious(config));
	}
	return fs.fs;
}

const MSG = "文件服务响应异常，你无法自行解决，请向管理员确认 URL 是否配置正确。";
/**
 *
 * @param {string} baseUrl
 * @param {string} pat
 * @returns {Promise<void>}
 */
const ensureFsAvailability = async (baseUrl, pat) => {
	const nonce = crypto.randomUUID();
	const exceptResult = new SHA256().update(nonce+'AiChat').toString();

	let json;
	try {
		json = await jsonFetch(baseUrl+"ping", {
			key: pat,
			body: JSON.stringify({nonce})
		});
	} catch (e) {
		throw MSG+"\n原始错误信息: "+e;
	}
	if (json.pong !== exceptResult) throw MSG;
};

const chooseApiServer = async () => {
	const servers = await listApiServers();
	return new Promise((resolve, reject) => {
		let el;
		const useServer = async uri => {
			uri = uri.trim();
			if (!uri) return false;

			const separator = uri.lastIndexOf('@');

			let baseUrl = separator < 0 ? uri : uri.slice(0, separator);
			const pat = separator < 0 ? undefined : uri.slice(separator + 1);
			if (!baseUrl.endsWith('/')) baseUrl += '/';

			const server = [baseUrl+"fs/", pat];

			try {
				await ensureFsAvailability(...server);
			} catch (e) {
				showToast(prettyError(e), 'error');
				return false;
			}

			upsertApiServer(uri);
			el?.remove();
			resolve(server);
		};

		el = SimpleModal({
			title: "🐳 缚印·择契",
			message: (
				<div className="md">
					<p>欲借鲸力，先呈<ruby>通行之契<rt>文件系统访问 URI</rt></ruby>。旧契若仍在，叩之即可再用。</p>
					<div className="agent-popup fs-options">
						{servers.map(({uri}) => <div className="option">
							<button className="btn ghost" onClick={() => useServer(uri)}>
								🐳 {uri}
								<button className="ri-delete-bin-line" title="删除最近访问项" onClick.stop={({target}) => {
									deleteApiServer(uri);
									target.closest("div").remove();
								}}></button>
							</button>
						</div>)}
					</div>
				</div>
			),
			type: "input",
			placeholder: "http://localhost:3003/api/@PAT",
			confirmMessage: "缔结新契",
			onConfirm: useServer,
			onCancel: null
		});
	});
};

/**
 * 调用 File Browser Interface (FBI) 选择文件系统实现
 * 这绝对不是我瞎编的接口！
 * @param {AiChat.Conversation} mountPoint
 * @return {Promise<AiChat.FileSystemInstance>}
 */
async function callFBI(mountPoint) {
	let {fs_builtin, fs_type, fs_base, fs_name} = mountPoint;
	if (config.fs_autoMount && fs_builtin) {
		if (!isIDB) {
			// 有云端就用云端
			fs_type = mountPoint.fs_type = 'db';
		} else if (directoryPickerAvailable) {
			// 否则使用文件夹名称
			fs_type = mountPoint.fs_type = 'local';
		} else {
			// 否则回退到 OPFS
			fs_type = mountPoint.fs_type = 'opfs';
		}
	}

	const getFSBase = async (showShellWarning, fsApi) => {
		let directories = [];
		if (fsApi) {
			try {
				const entries = await fsApi('list', {
					path: '.',
					pattern: '*',
					json: true,
					limit: 50,
					showDir: true
				});
				directories = entries.filter(item => item[1] === 'dir').map(item => '/'+item[0]);
			} catch (e) {
				console.warn("读取文件系统目录失败", e);
			}
		}

		const datalistId = "fsBase-"+crypto.randomUUID();
		return new Promise(resolve => {
			SimpleModal({
				type: "input",
				title: "📌 定域",
				message: (
					<div className={"md"}>
						<p>既择此道，须划定<ruby>疆界<rt>工作目录</rt></ruby>。根为 <kbd>/</kbd>，然天道不可直取，当择一<span className="highlight"><ruby>子域<rt>子目录</rt></ruby></span>以安天下。</p>
						<p>例：<kbd>/my-project-1</kbd>，勿授全根，慎之。</p>
						<p>此域日后仍可易之，入命<kbd>/fsreset</kbd> 即可<ruby>改弦更张<rt>重置路径</rt></ruby>。</p>
						{showShellWarning && <q>⚠️ <ruby>令咒<rt>命令</rt></ruby>可越藩篱，若于异容器中运行，则无此隐忧</q>}
					</div>
				),
				value: "/"+(fs_base||''),
				list: datalistId,
				after: <datalist id={datalistId}>{directories.map(path => <option value={path}/>)}</datalist>,
				confirmMessage: "定此域",
				accent: "primary",
				onConfirm(value) {
					resolve(normalizePath(value).join('/'));
				},
				onCancel: null
			});
		});
	};

	if (!fs_type) {
		fs_type = await new Promise((resolve, reject) => {
			const el = SimpleModal({
				title: mountPoint.fs_label || ("少年，与 "+(fs_name||"项目根目录")+" 签订契约吧！"),
				message: (
					<div className={"fs-protocols agent-popup"}
						 onClick.delegate{"button"}={({delegateTarget}) => {
						el.remove();
						resolve(delegateTarget.className);
					}}>
						{!isIDB && <div>
							<button className={"db"} title={"数据库后端的文件访问服务"}>🗄️ 典藏</button>
							<span>典于云端，多端同步如一。<br/>不可行令，记忆、角色等宜归于此。</span>
						</div>}
						<div>
							<button className={"api"} title={"专用文件访问服务(见Readme.md)"}>🐳 缚印</button>
							<span>缚于容器，如囚于笼，可运行万般程序。<br/>务必置于容器之内，方得施展。</span>
						</div>
						{directoryPickerAvailable && <div>
							<button className={"local"} title={"浏览器的showDirectoryPicker API"}>📁 启门</button>
							<span>推开现世之扉，直抵本地文件。<br/>浏览器亲自操刀，无有阻隔。</span>
						</div>}
						<div>
							<button className={"config"}>📜 化卷</button>
							<span>化数据为卷，供AI濡墨批阅。<br/>含配置、对话、预设、角色卡等，唯API Key隐去。<b
								style={"color:red"}>慎之，隐私如玉！</b></span>
						</div>
						<div>
							<button className={"opfs"}>🌀 藏渊</button>
							<span>藏于虚空，浏览器私库（OPFS），<br/>数据栖于斯，亦可导出。</span>
						</div>
					</div>
				),
				confirmMessage: "容后再议",
				accent: "ghost",
				onConfirm() {
					reject("User aborted the request")
				},
				onCancel: null,
			});
		});

		if (fs_type === 'api') {
			const server = await chooseApiServer();
			mountPoint.fs_server = server;
			fs_base = await getFSBase(1, remoteFileSystem(...server));
		}
		if (fs_type === 'opfs' || fs_type === 'db') {
			const server = fs_type === 'db' && [config.db_server+'fs/', config.db_pat];
			if (server) await ensureFsAvailability(...server);
			fs_base = await getFSBase(0, server && remoteFileSystem(...server));
		}
		if (fs_type === 'config') {
			fs_base = await new Promise((resolve, reject) => {
				SimpleModal({
					type: "input",
					title: "📜 化卷·圈地",
					message: (
						<div className={"md"}>
							<p>"化卷"之道，乃拟态软件数据为文牍。AI笔锋所至，皆可增删改易，故须<q>“先明其制，后授其权”</q>。</p>

							<p>卷中纲目如下：</p>
							<ul>
								<li><kbd>kv/</kbd> — <ruby>杂记<rt>键值存储</rt></ruby>，含<ruby>心念<rt>用户记忆</rt></ruby>、<ruby>画壁<rt>背景图</rt></ruby>等</li>
								<li><kbd>kvs/</kbd> — <ruby>法度<rt>预设</rt></ruby>与<ruby>命格<rt>角色卡</rt></ruby>汇于此</li>
								<li><kbd>conversations/</kbd> — <ruby>往昔言录<rt>对话记录</rt></ruby>，以<ruby>编年<rt>ID</rt></ruby>分卷</li>
								<li><kbd>config.json</kbd> — 当前<ruby>契约<rt>配置</rt></ruby></li>
							</ul>

							<p>若欲画地为牢，可于此填写<ruby>前导之径<rt>路径前缀</rt></ruby>：</p>
						</div>
					),
					placeholder: "⚠️ 若留空不填，则AI执掌全卷，无所不窥、无所不书。此权极重，慎之再慎。",
					after: (
						<div className={"md"}>
							<p>例：<kbd>kv/</kbd> — 则AI仅能涉足<q>杂记</q>一域，不得染指言录与法度。</p>
							<p>例：<kbd>conversations/652/</kbd> — 则仅可见<q>第652卷</q>，余者皆隐。</p>
							<blockquote style={"border-left-color: \#e55"}>
								<p>虽<ruby>印信<rt>API Key</rt></ruby>已被抹去，然卷中<strong style={"color: \#f66"}>言录历历、心念昭昭</strong>——汝之所思、所语、所忆，尽在其中。</p>
								<p>隐私如玉，碎之不可复全。<b style={"color: \#f66"}>数据无价，<ruby>谨慎操作<rt>他妈的给我备份！</rt></ruby>。</b></p>
								<p>——<i>“授人以笔，当知其可书亦可毁。”</i></p>
							</blockquote>
						</div>
					),
					confirmMessage: "定此疆界",
					onConfirm: resolve,
					onCancel() {
						reject("User aborted the request");
					},
				});
			});
		}

		if (fs_base) mountPoint.fs_base = fs_base;
		else delete mountPoint.fs_base;
		mountPoint.fs_type = fs_type;
	}

	switch (fs_type) {
		case "db": {
			await ensureFsAvailability(config.db_server+'fs/', config.db_pat);
			return remoteFileSystem(config.db_server+'fs/', config.db_pat, fs_base);
		}
		case "api": {
			const [baseUrl, pat] = mountPoint.fs_server;
			await ensureFsAvailability(baseUrl, pat);
			return remoteFileSystem(baseUrl, pat, fs_base);
		}
		case "local": {
			const fs = webFileSystemInstances.get(fs_base);
			if (!fs) {
				if (!webFileSystemInstances.size) {
					const folders = await listFolders();
					for (const folder of folders) {
						webFileSystemInstances.set(folder.name, {
							handle: folder.handle
						});
					}
				}

				return new Promise((resolve, reject) => {
					let el;
					const onClick = () => {
						directoryPickerAvailable({
							id: APP_NAME+"_agent_root",
							mode: "readwrite"
						}).then(handle => {
							const folderName = handle.name;
							if (!folderName) throw "选择的文件夹没有名称";

							const fs = createWebFileSystem(handle, unconscious(config));
							webFileSystemInstances.set(folderName, {
								handle,
								fs
							});
							upsertFolder(handle, folderName);
							mountPoint.fs_base = folderName;
							return fs;
						}).then(resolve).catch(reject).finally(() => el?.remove());

						return false;
					};

					if (!fs_base && !webFileSystemInstances.size) {
						onClick();
						return;
					}
					const oldChoice = webFileSystemInstances.get(fs_base);
					if (oldChoice) {
						resolve(initializeWebFileSystem(oldChoice));
						return;
					}

					el = SimpleModal({
						title: "📁 启门·忆旧径 "+(fs_name||""),
						message: (
							<div className="md" style={"position: relative"}>
								{fs_base && <blockquote>
									曾启之门「<q>{fs_base}</q>」<ruby>虽铭于心，却未寻得实径<rt>浏览器文件系统刷新后失效</rt></ruby>。
								</blockquote>}
								{webFileSystemInstances.size && <p>{fs_base ? "若欲改投他门，可叩下方已存之门扉；": "故门仍在，一触即入，旧卷悉陈。"}</p>}
								<div className={"agent-popup fs-options"}>
									{Array.from(webFileSystemInstances.entries()).map(([name, instance]) => (
										<div className="option">
											<button className="btn ghost"
													onClick={() => {
														el.remove();
														upsertFolder(instance.handle, name);
														mountPoint.fs_base = name;
														resolve(initializeWebFileSystem(instance));
													}}>
												📂 {name}
												<button className={"ri-delete-bin-line"} title={"删除最近访问项"} onClick.stop={({target}) => {
													deleteFolder(name);
													target.closest("div").remove();
												}}></button>
											</button>
										</div>
									))}
								</div>
								<p style={"text-align:right"}>{fs_base ? "唤「启新门」重择之。" : "推开现世之扉，另定一域。"}</p>
							</div>
						),
						confirmMessage: "🚪 启新门",
						accent: "primary",
						onConfirm: onClick,
						onCancel: null
					});
				})
			}
			return initializeWebFileSystem(fs);
		}
		case "opfs": {
			let baseDir = await navigator.storage.getDirectory();
			if (fs_base) baseDir = await resolveDirectory(baseDir, fs_base, {create:true});
			return createWebFileSystem(baseDir, {});
		}
		case "config": return createConfigFileSystem(fs_base);
		case "vfs": return createVirtualFileSystem(fs_base);
	}
}

/**
 *
 * @param {string} baseUrl
 * @param {string} pat
 * @param {string=} fileBase
 */
export const remoteFileSystem = (baseUrl, pat, fileBase) =>
	/**
	 * @param {string} func
	 * @param {Record<string, string>} parameters
	 * @returns {Promise<any|Blob|ContentPart|string>}
	 */
	async (func, parameters) => {
		let endpoint = baseUrl+func;

		if (fileBase) endpoint += '?root='+encodeURIComponent(fileBase);

		// ── Binary write / append: send raw Uint8Array body ──
		const isBinaryWrite = func === 'writeRaw' || func === 'appendRaw';
		let body, headers = {
			Authorization: 'Bearer '+pat
		};
		if (isBinaryWrite && parameters) {
			// Append extra params as query string
			const sep = endpoint.includes('?') ? '&' : '?';
			endpoint += sep + 'path='+encodeURIComponent(parameters.path);
			body = parameters.content;
			headers['Content-Type'] = 'application/octet-stream';
		} else if (parameters) {
			body = JSON.stringify(parameters);
			headers['Content-Type'] = 'application/json';
		}

		let response;
		try {
			response = await fetch(endpoint, {
				method: parameters ? 'POST' : 'GET',
				headers,
				body,
			});
		} catch (e) {
			throw "FileService dead";
		}

		const content = response.headers.get("content-type") || "";

		if (!response.ok) {
			if (response.status === 404) {
				throw `${func} is not implemented in this VFS`;
			}

			if (content.includes("application/json")) throw (await response.json()).error;
			throw (await response.text());
		}

		if (content.startsWith("image/")) return new ContentPart().image(await response.blob());
		if (content === "application/octet-stream") return await response.blob();
		if (content.includes("application/json")) return await response.json();
		return await response.text();
	};


const writeTools = new Set(["write", "patch", "edit", "delete"]);

export const createFileSystem = (config) => {
	let fs = config[FS_INSTANCE];
	if (fs) return fs;

	let promise = config[FS_OPENING];
	if (!promise) {
		promise = config[FS_OPENING] = callFBI(config);
		promise.then(fs => config[FS_INSTANCE] = fs);
		promise.finally(() => {delete config[FS_OPENING];});
	}
	return promise;
};

export const callFileSystemFunc = (fs, func, parameters, conv) => {
	if (typeof fs === 'function') return fs(func, parameters, conv);

	const handler = fs[func];
	if (!handler) throw `${func} is not implemented in this VFS`;
	return handler(parameters);
};

/**
 *
 * @param {string} path
 * @param {AiChat.Conversation} conv
 * @returns {Promise<[string, AiChat.FileSystemInstance]>}
 */
export const getFileSystem = async (path, conv) => {
	if (path) {
		if (path.startsWith("~/")) {
			let end = path.indexOf('/', 2);
			const mountPoint = conv.mnt?.[path.slice(2, end < 0 ? path.length : end)];
			if (!mountPoint) throw `mount point ${path} not found`;
			return [end < 0 ? "" :path.slice(end+1), await createFileSystem(mountPoint)];
		}

		if (conv.fs_type !== 'api' && path[0] === '/' && !path.startsWith("/tmp/") && path !== '/tmp')
			throw `Absolute path ${JSON.stringify(path)} is strictly forbidden, use ${JSON.stringify(path.slice(1))} instead`;
	}
	const myfs = await createFileSystem(conv);
	return [path, myfs];
};

export const fileAccess = (func) => async (parameters, _, conv) => {
	let path = parameters.path||parameters.cwd;
	// This is Global not per-fs alert
	if (conv.fs_readonly && writeTools.has(func)) throw "Write-protect is enabled";

	let [newPath, fs] = await getFileSystem(path, conv);

	if (newPath !== path) {
		parameters = { ...parameters };
		parameters['cwd' in parameters ? 'cwd' : 'path'] = newPath;
	}

	return callFileSystemFunc(fs, func, parameters, conv);
};

// UI

const state = $state();
const updateEstimate = () => navigator.storage.estimate().then(t => state.value = formatSize(t.usage) + "/" + formatSize(t.quota));
const opfsDialog = <div className={"choice-scroll"}>
	<button className={"btn danger"} onClick={() => {
		SimpleModal({
			title: "清空私库（OPFS）？",
			message: "这包括:\n配置文件系统（化卷）中的临时数据\n源私有文件系统（藏渊）中的所有数据\n申请了存储权限的插件数据\n\n重要数据请通过交互式下载（FileTransfer）工具打包导出",
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

export const FILESYSTEM_AUX_PROMPT = debugSymbol("ShellAvailabilityKnown");

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
}, {
	id: "fs_trashCan",
	_tab: "tools",
	name: "启用回收站",
	title: "仅影响前端文件系统（启门），后端由CLI flag控制，其它文件系统不支持。\n回收站在 /.trash 文件夹并按删除时间排序，此文件夹隐藏且只读，你可以命令Agent或手动恢复。\n关闭并不会删除回收站中的文件",
	type: "radio",
	required: true,
	choices: {
		'启用': true,
		'禁用': false,
	}
});

/**
 *
 * @param {AiChat.Conversation} conv
 */
export const resetFileAccessSettings = conv => {
	delete conv.fs_base;
	delete conv.fs_type;
	delete conv.fs_server;
	delete conv[FS_INSTANCE];
	delete conv[FILESYSTEM_AUX_PROMPT];
};

COMMAND_REGISTRY["fsreset"] = [
	(args) => {
		const conv = unconscious(selectedConversation);
		if (!conv) return;
		resetFileAccessSettings(conv);
		showToast("下一次文件操作将要求重新选择");
	},
	"重置文件系统选择"
];
