/**
 * @type {Map<string, Function[]>}
 */
const windows = new Map;

window.editorProxy = {
	onClose(name) {
		const callbacks = windows.get(name);
		if (callbacks) {
			windows.delete(name);
			for (let callback of callbacks) {
				callback();
			}
		}
	}
};

/**
 *
 * @param {string} key
 * @param {function(): string} getValue
 * @param {function(string): void} setValue
 * @return {[(function(): void), (function(function(): void): void)]}
 */
export function openJsonEditor(key, getValue, setValue) {
	const scopedKey = `${UC_PERSIST_STORE}:${key}`;

	Object.defineProperty(editorProxy, scopedKey, {
		get: getValue,
		set: setValue,
		configurable: true
	})

	const editor = window.open("./json_editor.html", key, "popup");
	const closeEditor = () => editor.close();
	let isOpen = true;

	const callbacks = [() => {
		isOpen = false;
		delete editorProxy[scopedKey];
		removeEventListener("beforeunload", closeEditor);
	}];
	windows.set(key, callbacks);

	addEventListener("beforeunload", closeEditor);

	return [() => editor.dispatchEvent(new StorageEvent("storage", {
			key: scopedKey,
			newValue: getValue()
	})), callbacks.push.bind(callbacks)];
}
