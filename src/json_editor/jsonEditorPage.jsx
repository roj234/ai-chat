import {$state, $store, AS_IS} from 'unconscious';
import './jsonEditorPage.css';
import {JsonEditor} from '/src/components/JsonEditor.jsx';

// 初始 Schema
const initialSchema = {
	schema: "https://json-schema.org/draft/2020-12/schema",
	title: "",
	description: "",
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false
};

const createTextState = () => {
	let id = 'json';
	let value;
	let storage;
	if (name) {
		id = name;
		value = `// 此链接已失效，请重新打开编辑器`;
		if (opener) {
			storage = {
				setItem(key, value) {
					opener.editorProxy[key] = value;
				},
				getItem(key) {
					return opener.editorProxy[key];
				}
			};
			addEventListener("beforeunload", () => opener.editorProxy.onClose(name));
		}
	} else {
		value = JSON.stringify(initialSchema, null, 2);
		storage = localStorage;
	}

	return $store(id, value, {persist: storage, deep: false, ser: AS_IS, deser: AS_IS});
}

const App = () => {
	const text = createTextState();
	const editor = $state();

	return (<>
			<div className="panel-header">
				<span className="panel-title"><i className="ri-code-s-slash-line"></i> JSON 编辑器</span>
				<div className="panel-actions">
					<button className="btn-icon" disabled={() => !editor.obj} onClick={() => {
						text.value = JSON.stringify(editor.obj, null, 2);
					}} title="美化">
						<i className="ri-magic-line"></i> 格式化
					</button>
					<button className="btn-icon" onClick={({target}) => {
						const raw = editor.obj ? JSON.stringify(editor.obj, null, 2) : text.value;
						navigator.clipboard.writeText(raw);
						alert("复制成功！");
					}} title="复制">
						<i className="ri-file-copy-line"></i> 复制
					</button>
				</div>
			</div>

			<div className="editor-container">
				<JsonEditor value={text} state={editor} />
			</div>

			{() => (
				editor.error ? (
					<div className="editor-error-footer">
						<i className="ri-alert-fill"></i>
						<span className="error-text">{editor.error}</span>
					</div>
				) : null
			)}
		</>
	);
};

document.body.replaceChildren(...App());