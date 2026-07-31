import {$store, AS_IS} from 'unconscious';
import {createEditorApp} from "./jsonEditorApp.js";

let id = name;
let value = `// 此链接已失效，请重新打开编辑器`;
let storage;

if (!id || !opener?.editorProxy?.[`${UC_PERSIST_STORE}:${id}`]) {
	window.close();
} else {
	storage = {
		setItem(key, value) {
			opener.editorProxy[key] = value;
		},
		getItem(key) {
			return opener.editorProxy[key];
		}
	};
	addEventListener("beforeunload", () => opener.editorProxy.onClose(id));
}

const textState = $store(id, value, {persist: storage, deep: false, ser: AS_IS, deser: AS_IS});
document.body.replaceChildren(createEditorApp(textState));