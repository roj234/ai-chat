import "./Editor.css";
import {$state} from "unconscious";
import {SyntaxEditor} from "./SyntaxEditor.jsx";
import {formatSize} from "unconscious/common/Utils.js";
import {openWindow} from "/src/components/Windows.jsx";
import {textDiff} from "unconscious/common/text-diff.js";
import {callFileSystemFunc, FS_SOURCE, vfsIdentity} from "/plugins/agent/index.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {downloadFile, prettyError} from "/src/utils/utils.js";
import {EVENT_BUS} from "/src/states.js";
import {winToast} from "./win-toast.js";
import {readAsString} from "/common/chardet.js";

const formatNumber = (n) => n.toLocaleString("en-US");

export const openEditor = async (fs, path, editable, language) => {
	const blob = await callFileSystemFunc(fs, 'readRaw', { path });

	let content = await readAsString(blob);
	const dirty = $state(false);
	const saving = $state(false);

	async function save() {
		if (saving.value || !dirty.value) return;
		saving.value = true;
		try {
			const lines = content.split('\n');
			const newContent = editor.getValue();

			const [ops, startLine, endLine] = textDiff(lines, newContent.split('\n'), true);
			let oldText = ops.filter(t => t.oldIndex != null).map(t => t.text).join('\n');
			let newText = ops.filter(t => t.newIndex != null).map(t => t.text).join('\n');

			await callFileSystemFunc(fs, 'atomicEdit', {
				path,
				oldTextHash: new SHA256().update(oldText).digest('hex'),
				newText,
				startLine,
				endLine: lines.length - endLine
			});

			content = newContent;
			dirty.value = false;

			// 触发文件资源管理器窗口重载
			EVENT_BUS.post(['fileChanged'], fs, path);
			winToast(toastDiv, '保存成功', 'ok');
		} catch (err) {
			winToast(toastDiv, '保存失败: '+prettyError(err), 'error')
		} finally {
			saving.value = false;
		}
	}

	const status = $state({});

	/* ------------------------------------------------------------------ *
	 * 界面
	 * ------------------------------------------------------------------ */

	let editor;
	let toastDiv;

	return openWindow({
		id: "preview "+encodeURI(vfsIdentity(fs[FS_SOURCE])+path),
		icon: <i className={"ri-file-line"}/>,
		title: path,
		actions: <>
			<button className="ri-reset-left-line btn ghost" disabled title="撤销" onClick={() => editor.undo()}/>
			<button className="ri-reset-right-line btn ghost" disabled title="重做" onClick={() => editor.redo()}/>
			<button className="ri-loop-line btn ghost" disabled title="刷新" onClick={() => {}}/>
			{editable && <button className="ri-save-line btn primary" disabled={() => !dirty.value || saving.value} onClick={save}>{() => saving.value ? '保存中…' : ''}</button>}
			<button className="ri-download-line btn ghost" title="下载" onClick={() => {downloadFile(new File([content], path))}}/>
		</>,
		element: () => {
			return <>
				{SyntaxEditor({
					value: content,
					readOnly: !editable,
					autofocus: true,
					language,
					onStatus: (status1) => {
						status.value = status1;
					},
					onChange: (text) => {
						dirty.value = true;
					},
					onReady: (api) => {
						editor = api;
					},
				})}

				<footer className="-status">
					<span className="-item">行 {() => status.line}，列 {() => status.ch}{() => status.selected ? ` (${formatNumber(status.selected)} 字符, unk 行)` : ""}</span>
					<span className="-sep"/>
					<span className="-item">{() => formatNumber(status.lineCount)} 行 · {() => formatSize(status.chars)}</span>
				</footer>

				<div className="win-toasts" ref={toastDiv} />
			</>
		}
	});
};