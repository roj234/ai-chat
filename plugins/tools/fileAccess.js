import {IndexedDBAccess} from "/src/utils/dbAccess.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {updateOnIntersected} from "/src/utils/utils.js";
import {SETTINGS} from "/src/settings.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {config, selectedConversation} from "/src/states.js";
import {showToast} from "/src/components/Toast.js";
import {createWebFileSystem, resolveDirectory} from "./WebFileSystem.js";
import {createVirtualFileSystem} from "./VirtualFileSystem.js";
import {ContentPart} from "/src/toolset.js";
import {jsonFetch} from "/common/openai-api-utils.js";
import {$state, debugSymbol, unconscious} from "unconscious";
import {formatSize} from "unconscious/common/Utils.js";
import {isIDB} from "/src/database.js";
import {SHA256} from "unconscious/common/SHA256.js";
import "./fileAccess.css";

/** @type {Map<string, {
 * handle: FileSystemDirectoryHandle,
 * fs: AiChat.FileSystemInstance
 }>} */
const webFileSystemInstances = new Map;

const STORE_NAME = 'folders';
const MAX_FOLDERS = 10;

const [transaction, deleteDatabase] = IndexedDBAccess(APP_NAME+":fileAccess", 1, (event) => {
	const db = event.target.result;
	db.createObjectStore(STORE_NAME, { keyPath: 'name' });
});

/**
 *
 * @returns {Promise<{name: string, handle: FileSystemDirectoryHandle, lastAccessed: number}[]>}
 */
const listFolders = () => {
	return transaction((tx, resolve) => {
		const request = tx.objectStore(STORE_NAME).getAll();
		request.onsuccess = (event) => resolve(event.target.result.sort((a, b) => b.lastAccessed - a.lastAccessed));
	}, false, STORE_NAME);
};

/**
 * @param {string} name
 * @returns {Promise<{name: string, handle: FileSystemDirectoryHandle, lastAccessed: number} | null>}
 */
const getFolder = name => transaction((tx) => tx.objectStore(STORE_NAME).get(name), false, STORE_NAME);

/**
 * 新增或更新文件夹记录
 * @param {FileSystemDirectoryHandle} handle
 * @param {string} name
 */
const upsertFolder = (handle, name) => transaction((tx) => {
	tx.objectStore(STORE_NAME).put({
		name: name || handle.name,
		handle,
		lastAccessed: Date.now(),
	});
	listFolders().then(folders => {
		folders.splice(MAX_FOLDERS).forEach(item => {
			deleteFolder(item);
		})
	})
}, true, STORE_NAME);

/**
 * 删除文件夹记录
 * @param {string} name
 */
const deleteFolder = (name) => transaction((tx) => tx.objectStore(STORE_NAME).delete(name), true, STORE_NAME);

const directoryPickerAvailable = window.showDirectoryPicker;

const FS_OPENING = debugSymbol("FS_OPENING");
const FS_INSTANCE = debugSymbol("FS_INSTANCE");

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
		fs.fs = createWebFileSystem(fs.handle);
	}
	return fs.fs;
}

export const getFsApiUrlPat = () => {
	let [baseUrl, pat] = (import.meta.env.DEV ? config.fs_server || "/api" : config.fs_server).split('@');
	if (!baseUrl.endsWith('/')) baseUrl += '/';
	baseUrl += "fs/";
	return [baseUrl, pat];
};
const MSG = "文件系统API响应格式有误。此异常不可重试，无法恢复，请向系统管理员确认 URL 是否配置正确。";
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

	const getFSBase = (showShellWarning) => new Promise(resolve => {
		SimpleModal({
			type: "input",
			title: "📌 定域",
			message: (
				<div className={"md"}>
					<p>既择此道，须划定
						<ruby>疆界
							<rt>工作目录</rt>
						</ruby>
						。根为 <kbd>/</kbd>，然天道不可直取，当择一<span className="highlight"><ruby>子域<rt>子目录</rt></ruby></span>以安天下。
					</p>
					<p>例：<kbd>/my-project-1</kbd>，勿授全根，慎之。</p>
					<p>此域日后仍可易之，入命<kbd>/fs_reset</kbd> 即可<ruby>改弦更张<rt>重置路径</rt></ruby>。</p>
					{showShellWarning && <q>⚠️ <ruby>令咒<rt>命令</rt></ruby>可越藩篱，若于异容器中运行服务，则无此隐忧</q>}
				</div>
			),
			value: "/"+(fs_base||''),
			confirmMessage: "定此域",
			accent: "primary",
			onConfirm(value) {
				resolve(value.startsWith('/') ? value.slice(1) : value);
			},
			onCancel: null
		});
	});

	if (!fs_type) {
		fs_type = await new Promise((resolve, reject) => {
			const el = SimpleModal({
				title: "少年，与 "+(fs_name||"项目根目录")+" 签订契约吧！",
				message: (
					<div className={"file-protocols agent-popup"}
						 onClick.delegate{"button"}={({delegateTarget}) => {
						el.remove();
						resolve(delegateTarget.className);
					}}>
						{!isIDB && <div>
							<button className={"db"} title={"数据库后端的文件访问服务"}>🗄️ 典藏</button>
							<span>典于云端，多端同步如一。<br/>不可行令，记忆、角色等宜归于此。</span>
						</div>}
						{config.fs_server && <div>
							<button className={"api"} title={"专用文件访问服务(见Readme.md)"}>🐳 缚印</button>
							<span>缚于容器，如囚于笼，可运行万般程序。<br/>务必置于容器之内，方得施展。</span>
						</div>}
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
			const [baseUrl, pat] = getFsApiUrlPat();
			await ensureFsAvailability(baseUrl, pat);
			// TODO  dialog for this
			//mountPoint.fs_server = [baseUrl, pat];
			fs_base = await getFSBase(1);
		}
		if (fs_type === 'opfs' || fs_type === 'db') {
			if (fs_type === 'db') await ensureFsAvailability(config.db_server+'fs/', config.db_pat);
			fs_base = await getFSBase(0);
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
			return remoteFileSystem(config.db_server+'fs/', config.db_pat, fs_base);
		}
		case "api": {
			const [baseUrl, pat] = mountPoint.fs_server || getFsApiUrlPat(config.fs_server);
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

							const fs = createWebFileSystem(handle);
							webFileSystemInstances.set(folderName, {
								handle,
								fs
							});
							upsertFolder(handle, folderName);
							if (mountPoint.fs_base !== folderName) {
								mountPoint.fs_base = folderName;

								SimpleModal({
									title: "📁 启门·立新约",
									message: (
										<div className={"md"}>
											<p>新门已立，名曰：<q>“{folderName}”</q>。</p>
											<p>
												日后每次归返，须<q><ruby>择同一门<rt>选择相同文件夹</rt></ruby></q>，方可再入此间。
												倘误闯他门，则前尘尽断，无可追忆。
											</p>
											<em>
												——<i>“今之所择为 <b>{folderName}</b>，来日亦当如是。”</i>
											</em>
										</div>
									),
									confirmMessage: `允`,
									accent: 'ghost',
									onCancel: null
								});
							}
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
								<div className={"agent-popup"} style={{
									display: "flex",
									"flex-wrap": "wrap",
									gap: "0.5rem"
								}}>
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
			return createWebFileSystem(baseDir);
		}
		case "config": return createVirtualFileSystem(fs_base);
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
			throw "network error";
		}

		if (!response.ok) throw (await response.text());

		const content = response.headers.get("content-type") || "";
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
	if (!handler) throw `[Unrecoverable error: ${func} is not implemented in current filesystem]`;
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
			const path1 = path.slice(2).split("/");
			const mountPoint = conv.mnt?.[path1.shift()];
			if (!mountPoint) throw `mount point ${path} not found`;

			return [path1.join('/'), await createFileSystem(mountPoint)];
		}

		if (path[0] === '/' && (conv.fs_type !== 'api' || !path.startsWith("/tmp/") && path !== '/tmp'))
			throw `Absolute path ${JSON.stringify(path)} is strictly forbidden, use ${JSON.stringify(path==='/'?'.':path.startsWith("/home/")||path.startsWith("/root/")?'~/path/to/file':path.slice(1))} instead`;
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
	id: "fs_server",
	_tab: "tools",
	name: "专用文件访问服务",
	title: "可选, 提供文件访问和命令执行功能\n请在容器中部署",
	type: "input",
	pattern: /^(\/|https?:\/\/)/,
	warning: "请输入合法的API端点",
	placeholder: "http://localhost:1/api/"
}, {
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
		'手动选择': false,
		'自动映射': true
	}
});

COMMAND_REGISTRY["fsreset"] = [
	(args) => {
		const conv = unconscious(selectedConversation);
		if (!conv) return;

		delete conv.fs_base;
		delete conv.fs_type;
		delete conv[FS_INSTANCE];
		delete conv[FILESYSTEM_AUX_PROMPT];
		showToast("下一次文件操作将要求重新选择");
	},
	"重置文件系统选择"
];
