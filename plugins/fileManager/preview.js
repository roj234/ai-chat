import {loadLanguage} from "/src/markdown/highlight.js";
import {readAsString} from "/common/chardet.js";
import {closeWindow, openWindow} from "/src/components/Windows.jsx";
import {AudioPlayer} from "/src/components/AudioPlayer.jsx";
import {showToast} from "/src/components/Toast.js";
import {formatDate, formatSize, immutableObjectMap} from "unconscious/common/Utils.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";
import {ImagePane} from "/src/components/ImagePane.jsx";
import {callFileSystemFunc, FS_SOURCE, vfsIdentity} from "../agent/index.js";
import {openFileBrowser} from "./Explorer.jsx";
import {config} from "/src/states.js";
import "./preview.css";
import {vfsDownload} from "./downloader.js";
import {openFileEditor} from "/plugins/fileManager/Editor.js";
import {HighlightBox} from "/src/components/TextDiff.jsx";
import {resolveVirtualUrl} from "./_vfsVirtualUrl.js";

/**
 * @typedef {{ name: string, path: string, size: number, mtime?: number }} DownloadJob
 */

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
	text: { width: 650, height: 800, icon: <i className="ri-file-code-fill" /> },
	html: { width: 700, icon: <i className="ri-file-code-fill" /> },
	image: { icon: <i className="ri-file-image-fill" /> },
});


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
					<b>受限模式，未运行脚本（脚本可以删你的文件，偷你的密钥）。</b>
				</div>

				<button className="btn danger-focus" onClick={({currentTarget}) => {
					const self = currentTarget.closest(".iframe-warning");
					const frame = self.nextElementSibling;
					frame.sandbox += ' allow-scripts';
					frame.src += '';
					self.remove();
				}}>信任
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

const PREVIEW_TEXT_MAX = 2000000;
const PREVIEW_NOSW_MAX = 20000000;

const EISDIR = '\0';

/**
 * 打开预览窗口，TODO：实时更新
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @param {string} [overrideFileName]
 * @param {'auto' | 'yes' | 'no'} [editable]
 * @return {Promise<import("/src/components/Windows.jsx").WindowState>}
 */
export async function vfsPreview(fs, path, overrideFileName, editable) {
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
		kind = extname === 'txt' ? 'text' : 'code';
		if (editable !== 'yes') {
			if (extname === 'md') kind = 'markdown';
			else if (/xhtml|html|htm/i.test(extname)) kind = 'html';
		}

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

		editable = 'no';
	}

	if (kind === 'code') return openFileEditor(fs, path, editable !== 'no', extname);

	const previewWindow = openWindow({
		id: "preview "+encodeURI(vfsIdentity(fs[FS_SOURCE])+path),
		icon: <i className={"ri-file-3-line"}/>,
		title: path,
		actions: <div className="row">
			{editable !== 'no' && <button className="ri-edit-2-line ghost" title="编辑" onClick={() => {
				closeWindow(previewWindow);
				openFileEditor(fs, path, true, extname);
			}} />}
			<button className="ri-download-line ghost" title="下载" onClick={() => {
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
				// 这个支持自动折行，等我的编辑器支持再删
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

export {createEditorWidget} from "./Editor.js";