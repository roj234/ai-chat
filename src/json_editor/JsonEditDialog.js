import {$state} from "unconscious";
import {getWindow, openWindow} from "../components/Windows.jsx";
import {JsonEditor} from "../components/JsonEditor.jsx";
import './JsonEditDialog.css';
import {inspect} from "unconscious/common/inspect.js";
import {EVENT_BUS} from "../states.js";
import {Icon_warning} from "../components/Icons.jsx";

/**
 *
 * @param {string} key
 * @param {function(): string} getValue
 * @param {function(Object): void} setValue
 * @return {[(function(): void), (function(function(): void): void)]}
 */
export function openJsonEditor(key, getValue, setValue) {
	if (getWindow(key)) return;

	const textState = $state(getValue());
	const editorState = $state();

	const update = () => textState.value = getValue();
	const callbacks = [];
	const onClose = callback => callbacks.push(callback);

	const save = () => {
		for (let callback of callbacks) callback();
		const obj = editorState.obj;
		if (obj) setValue(obj);
	};

	const handle = openWindow({
		id: key,
		icon: <i className="ri-code-s-slash-line"></i>,
		title: key,
		actions: <div>
			<button className="je-btn" disabled={() => !editorState.obj} onClick={() => {
				textState.value = inspect(editorState.obj);
			}} title="美化">
				<i className="ri-magic-line"></i> 格式化
			</button>
			<button className="je-btn" disabled={() => !editorState.obj} onClick={save} title="保存">
				<i className="ri-save-line"></i> 保存
			</button>
		</div>,
		element: (<div className={"jsonEditorApp"}>
			<JsonEditor value={textState} state={editorState}/>
			{() => (
				editorState.error ? (
					<div className="editor-error row">
						<Icon_warning/>
						<span className="ellipsis">{editorState.error}</span>
					</div>
				) : null
			)}
		</div>)
	});

	const _off = EVENT_BUS.onoff(['closeWindow', handle.id], () => {
		_off();
		for (let callback of callbacks) callback();
	});

	return [update, onClose];
}
