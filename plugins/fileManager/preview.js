import {loadLanguage} from "/src/markdown/highlight.js";
import {readAsString} from "/common/chardet.js";
import {closeWindow, openWindow} from "/src/components/Windows.jsx";
import {HighlightBox} from "/src/components/TextDiff.jsx";
import {AudioPlayer} from "/src/components/AudioPlayer.jsx";
import {$state} from "unconscious";
import {downloadFile} from "/src/utils/utils.js";
import {ZipWriter} from "unconscious/common/zip-io.js";
import {showToast} from "/src/components/Toast.js";
import {formatDate, formatSize, immutableObjectMap} from "unconscious/common/Utils.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";
import {ImagePane} from "/src/components/ImagePane.jsx";
import {webviewStreamDownloadFile} from "/vendor/jsBridge.js";
import {callFileSystemFunc, FS_SOURCE, vfsIdentity} from "../agent/index.js";
import {openFileBrowser} from "./Explorer.jsx";
import {config} from "/src/states.js";
import "./preview.css";
import {createAsyncQueue} from "/common/pure-utils.js";

/** 单次下载的体积上限：1 GiB */
const MAX_DOWNLOAD_SIZE = 1024 ** 3;
/** 超过这个体积就不再压缩，Store 更快也更省内存 */
const MAX_COMPRESS_SIZE = 32 * 1024 ** 2;
/** 小块攒到这个体积再 flush */
const FLUSH_THRESHOLD = 1024 ** 2;
/** 默认打包名 */
const DEFAULT_ARCHIVE_NAME = '下载';

const tooLargeError = (size) => new Error(`体积 ${formatSize(size)}，超过单次 1 GB 的下载上限`);

/**
 * @param {(data: Blob, isLast: boolean) => Promise<void>} send
 * @param {(any) => Promise<void>} [abort]
 */
const bufferedWriter = (send, abort) => {
	let tmp = [];
	let tmpSize = 0;
	return new WritableStream({
		write(arr) {
			if (tmpSize + arr.length > FLUSH_THRESHOLD) {
				const blob = new Blob(tmp);
				tmp = [arr];
				tmpSize = 0;
				return send(blob, false);
			}
			tmp.push(arr);
			tmpSize += arr.length;
		},
		close: () => {
			const blob = new Blob(tmp);
			return send(blob, true);
		},
		abort,
	});
};

/**
 * 挑一种落盘方式
 * @param {string} filename
 * @param {number} [knownSize]
 * @return {FileSystemWritableFileStream | null} null 表示用户关掉了保存对话框
 */
const createDownloadTarget = async (filename, knownSize) => {
	if (IS_ANDROID_BUILD) {
		let id = null;
		const cb = i => id = i;
		return bufferedWriter((blob, isLast) => {
			return webviewStreamDownloadFile(blob, filename, isLast, id).then(cb);
		}, () => {
			//return id && webviewCancelDownloadFile(id);
		});
	}

	if (streamSavingIsSupported) {
		try {
			const handle = await showSaveFilePicker({ suggestedName: filename });
			/**
			 * @type {FileSystemWritableFileStream}
			 */
			const writable = await handle.createWritable();

			return bufferedWriter((blob, isLast) => {
				let p = writable.write(blob);
				if (isLast) p = p.then(() => writable.close());
				return p;
			}, (r) => writable.abort(r));
		} catch (e) {
			if (e?.name === 'AbortError') return;
		}
	}

	if (knownSize > MAX_DOWNLOAD_SIZE) throw tooLargeError(knownSize);
	return null;
};

const streamSavingIsSupported = window.showSaveFilePicker;

/**
 * @typedef {{ name: string, path: string, size: number, mtime?: number }} DownloadJob
 */

/**
 * 下载单个路径
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @param {string} name
 * @return {Promise<void>}
 */
export const vfsDownload = (fs, path, name) => vfsDownloadMany(fs, [{ path, name }], name);

/**
 * 下载多个文件/文件夹：只有一项且是文件时直接下载，其余情况打包为 zip
 * @param {AiChat.FileSystemInstance} fs
 * @param {{ path: string, name?: string, type?: 'file' | 'dir' }[]} items
 * @param {string} [archiveName] 打包文件名（不含 .zip）
 * @return {Promise<void>}
 */
export const vfsDownloadMany = async (fs, items, archiveName) => {
	const state = $state("正在列目录");

	const cancel = new AbortController();
	const signal = cancel.signal;

	const close = showToast(state, '', 0, {
		closeBtn: <button className="dct-undo" onClick={() => {
			cancel.abort();
		}}>取消下载</button>
	});
	/** @type {DownloadJob[]} */
	const jobs = [];
	let writer;
	let totalSize = 0;
	try {
		for (const item of items) {
			if (signal.aborted) return;

			const info = item.type === 'dir' ? item : await callFileSystemFunc(fs, 'stat', {
				path: item.path,
				json: true
			});

			if (info.type !== 'dir') {
				jobs.push({ name: item.name, path: item.path, size: info.size, mtime: info.mtimeMs });
				totalSize += info.size;
				continue;
			}

			const files = await callFileSystemFunc(fs, 'list', {
				path: item.path, pattern: "**", json: true, limit: 10000, showDir: false, showModified: true
			});
			for (const [relPath, , size, mtime] of files) {
				jobs.push({
					name: item.name + "/" + relPath,
					path: item.path + "/" + relPath,
					size,
					mtime,
				});
				totalSize += size;
			}
		}

		if (jobs.length === 1 && jobs[0].type !== 'dir') {
			const {name, path, size} = jobs[0];

			const target = await createDownloadTarget(name, totalSize);
			if (target === undefined) return;

			state.value = "正在下载 (无法获取进度)";

			if (target === null) {
				let blob = await callFileSystemFunc(fs, 'readRaw', {path, signal});
				blob = new File([blob], name, { type: blob.type });
				downloadFile(blob);
			} else {
				const res = await callFileSystemFunc(fs, 'readRaw', {path, stream: true});
				await res.body.pipeTo(target, {signal});
			}
		} else {
			const filename = (archiveName||DEFAULT_ARCHIVE_NAME)+".zip";
			const target = await createDownloadTarget(filename, totalSize);
			if (target === undefined) return;

			const startTime = Date.now();
			let downloadSize = 0;
			let downloadCount = 0;

			writer = target?.getWriter();
			const zw = ZipWriter(writer);

			const [enqueue, flush] = createAsyncQueue(4);

			for (let i = 0; i < jobs.length; i++) {
				if (signal.aborted) break;

				const it = jobs[i];
				if (it.size > MAX_DOWNLOAD_SIZE) {
					showToast(`文件 ${it.path} 过大，跳过`, 'error');
					continue;
				}

				await enqueue(async () => {
					const blob = await callFileSystemFunc(fs, 'readRaw', {path: it.path, signal});
					await zw.add(it.name, new Uint8Array(await blob.arrayBuffer()), {
						compression: blob.size < MAX_COMPRESS_SIZE,
						timestamp: it.mtime,
					});
					downloadCount++;
					downloadSize += blob.size;

					state.value = filename+": "+i+"/"+jobs.length+` 已下载 (${formatSize(downloadSize)}/${formatSize(totalSize)}}, ${formatSize(downloadSize / (Date.now() - startTime) * 1000)}/s)`;

				});
			}
			await flush();

			const blob = await zw.finish();
			if (writer) {
				await writer.write(blob);
				await writer.close();
			} else {
				blob.name = filename;
				downloadFile(blob);
			}
		}
	} finally {
		writer?.abort();
		close();
	}
};

const IMAGE_EXT = /jpg|jpeg|jpe|jfif|png|apng|gif|webp|bmp|svg|ico|avif|heic|heif/;
const VIDEO_EXT = /flv|mp4|m4v|ogv|mkv|mov|webm|avi|f4v/;
const AUDIO_EXT = /mp3|wav|ogg|oga|opus|flac|aac|m4a|mid|midi/;
const TEXT_EXT = /txt|log|rtf/;

const sizeByKind = immutableObjectMap({
	video: { width: 960, height: 600, icon: <i className="ri-file-video-fill" /> },
	audio: { width: 500, height: 85, resizable: false, icon: <i className="ri-file-music-fill" /> },
	binary: { width: 300, height: 200, resizable: false, icon: <i className="ri-file-unknow-fill" /> },
	'too-large': { width: 400, height: 200, resizable: false, icon: <i className="ri-error-warning-fill" /> },
	markdown: { width: 700, icon: <i className="ri-file-text-fill" /> },
	text: { icon: <i className="ri-file-code-fill" /> },
	html: { width: 700, icon: <i className="ri-file-code-fill" /> },
	image: { icon: <i className="ri-file-image-fill" /> },
});

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @return {?string}
 */
const resolveVirtualUrl = (fs, path) => {
	const sw = navigator.serviceWorker?.controller;
	const mount = fs[FS_SOURCE];
	if (sw && mount) return "vfs/"+(mount.fs_type+'@'+encodeURIComponent(mount.fs_base)+"@"+encodeURIComponent(mount.fs_server))+"/"+path;
}


const closeBtn = () =>
	<button className="close" onClick={({currentTarget}) => {
		const self = currentTarget.closest(".iframe-warning");
		self.remove();
	}}>✕</button>;

/**
 *
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} s
 * @param {string} path
 * @return {JSX.Element}
 */
function htmlRenderer(fs, s, path) {
	const virtualUrl = resolveVirtualUrl(fs, path);
	if (virtualUrl) {
		if (config.trustHTML) {
			return <iframe sandbox="allow-same-origin allow-scripts" src={virtualUrl}/>;
		}
		return <>
			<div className="iframe-warning">
				<i className="ri-error-warning-fill"/>

				<div style="flex:1; font-size:14px; line-height:1.7; color:#6B4E00;">
					<b>受限模式，因同源隔离问题，未执行脚本。</b>
				</div>

				<button className="btn danger-focus" onClick={({currentTarget}) => {
					const self = currentTarget.closest(".iframe-warning");
					const frame = self.nextElementSibling;
					frame.sandbox += ' allow-scripts';
					frame.src += '';
					self.remove();
				}}>允许执行
				</button>

				{closeBtn()}
			</div>
			<iframe sandbox="allow-same-origin" src={virtualUrl}/>
		</>;
	}

	return <>
		<div className="iframe-warning">
			<i className="ri-error-warning-fill"/>

			<div style="flex:1; font-size:14px; line-height:1.7; color:#6B4E00;">
				<b>看不到图片、点击没反应？</b>
				请到 <b style="background:#FFE08A; padding:2px 6px; border-radius:4px;">设置 → 数据</b>
				打开 <b>「资源缓存和VFS静态服务」</b>
			</div>

			{closeBtn()}
		</div>
		<iframe sandbox="allow-scripts" srcDoc={s} />
	</>;
}

export const PREVIEW_TEXT_MAX = 2000000;
const PREVIEW_NOSW_MAX = 20000000;

const EISDIR = '\0';

/**
 * 打开预览窗口，TODO：实时更新
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @param {string} [overrideFileName]
 * @param {(string) => void} [editText]
 * @return {Promise<import("/src/components/Windows.jsx").WindowState>}
 */
export async function vfsPreview(fs, path, overrideFileName, editText) {
	let data = !path ? EISDIR : await callFileSystemFunc(fs, 'readRaw', {path, metaOnly: true}).catch((e) => {
		if ((e.message || e).includes("ISDIR")) return EISDIR;
		throw e;
	});
	if (data === EISDIR) return openFileBrowser(fs, path);

	// 允许工具调用打断，加配置项

	let kind = 'binary';

	const filename = path.slice(path.lastIndexOf('/') + 1);
	const extname = filename.slice(filename.lastIndexOf('.') + 1);
	const directUrl = resolveVirtualUrl(fs, path);
	let canEdit = data.size < PREVIEW_TEXT_MAX;

	if (canEdit && (loadLanguage(extname, true) || TEXT_EXT.test(extname))) {
		kind = 'text';
		if (extname === 'md') kind = 'markdown';
		else if (/xhtml|html|htm/i.test(extname)) kind = 'html';

		if (directUrl && kind === 'html') {
			// 直接传原始URL过去就行
		} else {
			// 检测编码
			const blob = await callFileSystemFunc(fs, 'readRaw', {path});
			data = await readAsString(blob);
		}
	} else {
		if (IMAGE_EXT.test(filename)) kind = 'image';
		else if (VIDEO_EXT.test(filename)) kind = 'video';
		else if (AUDIO_EXT.test(filename)) kind = 'audio';

		if (directUrl) data.toUrl = () => directUrl;
		else if (data.size > PREVIEW_NOSW_MAX) kind = 'too-large';
		else data = await callFileSystemFunc(fs, 'readRaw', {path});

		canEdit = false;
	}

	const previewWindow = openWindow({
		id: "preview "+encodeURI(vfsIdentity(fs[FS_SOURCE])+path),
		icon: <i className={"ri-file-line"}/>,
		title: path,
		actions: <div className="row">
			{canEdit && editText && <button className="ri-edit-2-line btn ghost" title="编辑" onClick={() => {
				closeWindow(previewWindow);
				editText(data);
			}} />}
			<button className="ri-download-line btn primary" title="下载" onClick={() => {
				vfsDownload(fs, path, overrideFileName || filename).catch(err => {
					showToast('下载失败：' + (err?.message ?? err), 'error');
				});
			}} />
		</div>,
		element: () => {
			let el;
			switch (kind) {
				case 'markdown': el = renderMarkdownToElement(<div className="md" style="margin:16px" />, data, {
					fs,
					base: path.slice(0, path.lastIndexOf('/')+1),
				}); break;
				case 'text': el = <HighlightBox code={data} filename={filename} />; break;
				case 'video': el = <video style="width:100%;height:100%" src={data.toUrl()} controls />; break;
				case 'audio': el = <AudioPlayer src={data.toUrl()} />; break;
				case 'image': el = <div className="images"><ImagePane variant='' overlay="图像" blob={data}/></div>;break;
				case 'binary':case 'too-large':el = <div className="md col" style="align-items:center;justify-content:center;height:100%;gap:8px">
					<div style="font-size:12px">{formatSize(data.size)} · {formatDate("Y-m-d H:i:s", data.lastModified)}</div>
					<div style="font-size:14px">{kind === 'binary'
						? <>这个扩展名还不支持预览<br/>不过你总是可以下载它。</>
						: <>
							文件过大，无法在线预览。<br />
							请到 <b>设置 → 数据</b> 中启用 <code>资源缓存和VFS静态服务</code> 后再打开。
						</>
					}</div>
				</div>;
				break;
				case 'html': el = htmlRenderer(fs, data, path);break;
			}

			return el;
		},
		...sizeByKind[kind]
	});

	return previewWindow;
}
