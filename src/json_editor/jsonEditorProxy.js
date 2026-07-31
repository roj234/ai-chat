import {$store, $watch, unconscious} from "unconscious";

import {isMobile} from "../states.js";
import {createEditorApp} from "./jsonEditorApp.js";

if (!isMobile) {
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
}

/**
 * @type {Map<string, Function[]>}
 */
const windows = new Map;

/**
 *
 * @param {string} key
 * @param {function(): string} getValue
 * @param {function(string): void} setValue
 * @return {[(function(): void), (function(function(): void): void)]}
 */
export function openJsonEditor(key, getValue, setValue) {
	const scopedKey = `${UC_PERSIST_STORE}:${key}`;

	if (isMobile) {
		let skip;
		const textState = $store(getValue());
		const update = () => {
			textState.value = getValue();
			skip = true;
		};
		const callbacks = [];
		const onClose = callback => callbacks.push(callback);
		$watch(textState, () => {
			if (skip) skip = false;
			else setValue(unconscious(textState));
		}, false);


		const self = (h) => {
			return (e) => {
				if (e.target === element) h(e);
			}
		};

		const handleClose = () => {
			for (let callback of callbacks) {
				callback();
			}
			element.remove();
		}

		const element = (
			<div className="modal-overlay" onContextMenu.self.prevent={handleClose}>
				<div className="modal" style={"width:100vw;max-height:100vh;"} onClick={(e) => e.stopPropagation()}>
					{createEditorApp(textState, handleClose)}
				</div>
			</div>
		);
		document.body.append(element);
		return [update, onClose];
	}

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
