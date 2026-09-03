import {JsonEditor} from "../components/JsonEditor.jsx";
import {$state} from "unconscious";
import './jsonEditorApp.css';
import {stringify} from "/common/json5-stringify.js";

export const createEditorApp = (text, saveCallback) => {
	const editor = $state();

	return (<div className={"jsonEditorApp"}>
			<div className="panel-header">
				<span className="panel-title"><i className="ri-code-s-slash-line"></i> JSON 编辑器</span>
				<div className="panel-actions">
					<button className="btn-icon" disabled={() => !editor.obj} onClick={() => {
						text.value = stringify(editor.obj, null, 2);
					}} title="美化">
						<i className="ri-magic-line"></i> 格式化
					</button>
					<button className="btn-icon" onClick={() => {
						const raw = editor.obj ? JSON.stringify(editor.obj, null, 2) : text.value;
						navigator.clipboard.writeText(raw);
						alert("复制成功！");
					}} title="复制">
						<i className="ri-file-copy-line"></i> 复制
					</button>
					{saveCallback &&
						<button className="btn-icon" onClick={saveCallback} title="保存">
							<i className="ri-save-line"></i> 保存
						</button>}
				</div>
			</div>

			<JsonEditor value={text} state={editor}/>

			{() => (
				editor.error ? (
					<div className="editor-error">
						<i className="ri-alert-fill"></i>
						<span className="error-text">{editor.error}</span>
					</div>
				) : null
			)}
		</div>
	);
};