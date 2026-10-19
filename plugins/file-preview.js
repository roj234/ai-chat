import {EVENT_BUS, selectedConversation} from "/src/states.js";
import {loadLanguage} from "/src/markdown/highlight.js";
import {readAsString} from "/common/chardet.js";
import {openWindow} from "/src/components/Windows.jsx";
import {HighlightBox} from "/src/components/TextDiff.jsx";
import {AudioPlayer} from "/src/components/AudioPlayer.jsx";
import {fileAccess} from "./agent/index.js";
import {unconscious} from "unconscious";
import {downloadFile, prettyError} from "/src/utils/utils.js";
import {ZipWriter} from "unconscious/common/zip-io.js";
import {showToast} from "/src/components/Toast.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {formatSize} from "unconscious/common/Utils.js";

const binaryRead = fileAccess("readRaw");
const binaryWrite = fileAccess('writeRaw');

const openCreateFileWindow = () => {
	let resetHandler;
	const path = $state("");
	const content = $state();

	const submit = async () => {
		await binaryWrite({
			path: unconscious(path),
			content: unconscious(content),
			overwrite: true,
		}, {}, unconscious(selectedConversation)).then(() => {
			path.value = content.value = '';
		}, e => {
			showToast("写入失败\n"+prettyError(e));
		});
	}

	openWindow({
		id: "createFile",
		title: "创建文件",
		actions: <button className="btn primary" onClick={submit} disabled={() => !unconscious(content) || !unconscious(path)}>写入</button>,
		width: 500,
		height: 175,
		resizable: false,
		element: <div>
			<form ref={resetHandler}>
				<input type={"file"}
					   onChange={({target}) => {
						   content.value = target.files[0];
					   }}/>
			</form>

			<textarea
				rows={3}
				placeholder="在此输入文字，直接创建文本文件"
				className={"text-input"}
				onInput={({target}) => {
					content.value = target.value;
					resetHandler.reset();
				}}
				style={`height:auto`}
			/>

			<input className="text-input" placeholder="目标路径 (覆盖现有文件)" onInput={({target}) => path.value = target.value}/>
		</div>
	})
}

COMMAND_REGISTRY["upload"] = [
	openCreateFileWindow,
	"在当前对话的工作区创建文件"
];

/**
 * @param {string} path
 * @param {string} fileName
 * @return {Promise<void>}
 */
const handleDownload = async (path, fileName) => {
	const conv = unconscious(selectedConversation);
	let blob;

	try {
		blob = await binaryRead({ path }, {}, conv);
		blob = new File([blob], fileName, { type: blob.type });
	} catch {
		const files = await Glob.script({ path, pattern: "**", json: true }, response, conv);
		const zw = ZipWriter();

		for (const [relPath] of files) {
			const fullPath = path + "/" + relPath;
			const result = await binaryRead({ path: fullPath }, response, conv);
			await zw.add(relPath, result, { compression: true });
		}

		blob = zw.finish();
		blob.name = fileName + ".zip";
	}

	downloadFile(blob);
};

const IMAGE_EXT = /jpg|jpeg|jpe|jfif|png|apng|gif|webp|bmp|svg|ico|avif|heic|heif/;
const VIDEO_EXT = /flv|mp4|m4v|mkv|mov|webm|avi|f4v/;
const AUDIO_EXT = /mp3|wav|ogg|oga|opus|flac|aac|m4a|mid|midi/;
const TEXT_EXT = /txt|log|rtf/;

EVENT_BUS.on('resolveUrl', (path) => {
	const conv = unconscious(selectedConversation);
	return binaryRead( { path }, {}, conv).then(blob => blob.toUrl());
});
EVENT_BUS.on('viewUrl', async (path, _, node) => {
	const conv = unconscious(selectedConversation);
	let s = await binaryRead( { path }, {}, conv).catch((e) => {
		if (e.message.includes("ISDIR")) {
			return '#ISDIR';
		}
		throw e;
	});

	const filename = path.slice(path.lastIndexOf('/') + 1);
	const extname = filename.slice(filename.lastIndexOf('.') + 1);

	let kind = 'binary';
	if (s === '#ISDIR') {
		kind = 'folder';
	} else {
		if (IMAGE_EXT.test(filename)) kind = 'image';
		else if (VIDEO_EXT.test(filename)) kind = 'video';
		else if (AUDIO_EXT.test(filename)) kind = 'audio';
		else if (s.size < 1048576 && (loadLanguage(extname) || TEXT_EXT.test(extname))) {
			kind = 'text';
			s = await readAsString(s);
		}
	}

	openWindow({
		id: "filePreview-"+conv.id+"-"+path,
		icon: <i className={"ri-file-line"}/>,
		title: "预览 " + path,
		actions: <button className="btn primary" onClick={() => handleDownload(path, node.textContent || filename)}>下载</button>,
		element: () => {
			let el;
			switch (kind) {
				case 'text': el = <HighlightBox code={s} filename={filename} />; break
				case 'video': el = <video src={s} controls />; break;
				case 'audio': el = <AudioPlayer src={s} />; break;
				// 透明棋盘背景检测
				case 'image': el = <img src={s} alt={path} />; break;
				case 'binary': el = <div>不支持或过大的文件 {formatSize(s.size)}<br/>你可以尝试点击上方下载</div>;
			}

			return el;
		}
	})
})