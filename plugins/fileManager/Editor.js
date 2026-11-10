import "./Editor.css";
import {$state, $update, unconscious} from "unconscious";
import {TextEditor} from "./TextEditor.jsx";
import {formatSize} from "unconscious/common/Utils.js";
import {openWindow} from "/src/components/Windows.jsx";
import {textDiff} from "unconscious/common/text-diff.js";
import {callFileSystemFunc, FS_SOURCE, vfsIdentity} from "/plugins/agent/index.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {downloadFile, prettyError} from "/src/utils/utils.js";
import {EVENT_BUS} from "/src/states.js";
import {winToast} from "./win-toast.js";
import {readAsString} from "/common/chardet.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {createJsonParser} from "@roj234/stream-json";
import {AS_IS} from "@roj234/shared";

const formatNumber = (n) => n.toLocaleString("en-US");

export const openFileEditor = async (fs, path, editable, language) => {
	const fetchText = () => callFileSystemFunc(fs, 'readRaw', { path }).then(readAsString);

	let content = await fetchText();
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

	const editorState = $state();
	const editor = TextEditor({
		value: content,
		readOnly: !editable,
		autofocus: true,
		language,
		onStatus: (status1) => {
			status.value = status1;
			$update(editorState);
		},
		onChange: (text) => {
			dirty.value = true;
		},
		onContextMenu(items) {
			items.splice(2, 0, {
				icon: "ri-loop-right-line",
				label: "刷新",
				disabled: unconscious(saving),
				act() {
					const op = async () => {
						editor.setValue(content = await fetchText());
					};

					if (dirty.value && editor.getValue() !== content) {
						SimpleModal({
							title: "丢弃未保存的修改？",
							onConfirm: op
						});
					} else {
						op();
					}
				}
			});
			return items;
		}
	});
	editorState.value = editor;
	let toastDiv;

	return openWindow({
		id: "editor "+encodeURI(vfsIdentity(fs[FS_SOURCE])+path),
		icon: <i className={"ri-file-line"}/>,
		title: path,
		actions: <>
			<button className="ri-reset-left-line ghost" disabled={() => !editorState.canUndo()} title="撤销" onClick={() => editor.undo()}/>
			<button className="ri-reset-right-line ghost" disabled={() => !editorState.canRedo()} title="重做" onClick={() => editor.redo()}/>
			{editable && <button className="ri-save-line ghost" disabled={() => !dirty.value || saving.value} onClick={save}>{() => saving.value ? '保存中…' : ''}</button>}
			<button className="ri-download-line ghost" title="下载" onClick={() => {downloadFile(new File([content], path))}}/>
		</>,
		element: () => {
			return <>
				{editor.element}
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

export const createJson5Editor = async (skipVerify) => {
	let content = null;
	let object = null;
	let error = "";

	const status = $state({});
	const syntaxState = <span className="-item" />;

	const onChange = (string) => {
		let errPos;

		if (skipVerify) content = string;
		else  {
			const parser = createJsonParser(AS_IS, {json5: true});
			try {
				parser.write(string);
				object = parser.end();
				content = string;
				editor.setErrorLine(-1);
				error = syntaxState.textContent = "";
			} catch (e) {
				errPos = parser.pos();

				let line = 1;
				let lineStart = 0;
				let p = string.indexOf("\n");
				while (p !== -1 && p < errPos) {
					line++;
					lineStart = p + 1;
					p = string.indexOf("\n", lineStart);
				}
				const column = errPos - lineStart;

				error = syntaxState.textContent = e.message + " near "+line+","+column;
				object = null;
				editor.setErrorLine(line-1);
			}

			syntaxState.classList.toggle("err", !!error);
		}

		obj.onChange?.(content, object, error);
	};

	const editor = TextEditor({
		autofocus: true,
		language: 'json5',
		onStatus: (st) => {status.value = st;},
		onChange
	});

	const obj = {
		dom: <>
			{editor.element}
			<footer className="-status">
				<span
					className="-item">行 {() => status.line}，列 {() => status.ch}{() => status.selected ? ` (${formatNumber(status.selected)} 字符, unk 行)` : ""}</span>
				<span className="-sep"/>
				<span className="-item">{() => formatNumber(status.lineCount)} 行 · {() => formatSize(status.chars)}</span>
				<span className="-sep"/>
				{syntaxState}
			</footer>
		</>,
		setValue(text) {
			editor.setValue(text);
			onChange(text);
		}
	};
	return obj;
};