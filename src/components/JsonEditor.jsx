import "./JsonEditor.css";
import {$async, $cleanup, $state, $watch, unconscious} from "unconscious";
import {EVENT_BUS} from "../states.js";
import {inspect} from "@roj234/util-inspect";
import {focusWindow, getWindow, openWindow} from "./Windows.jsx";

const generateSkeleton = () => {
	const LINE_COUNT = 400 / 20 + 2;
	const skeleton = <div className="vje-sk" aria-hidden="true" />;

	for (let i = 0; i < LINE_COUNT; i++) {
		skeleton.append(<div className="-line"><span className="-num"></span><i className="-code" style={`--w:${Math.round(Math.random()*20)*5}%;--i:${Math.round(Math.random()*5)}`}></i></div>);
	}

	return skeleton;
};

/**
 * @param value
 * @param {Function} onChange
 * @param {boolean} [skipVerify]
 * @param {string} [placeholder]
 * @return {JSX.Element}
 */
export const JsonEditor = ({value = "", onChange, skipVerify, placeholder}) => {
	const isRawString = typeof unconscious(value) === 'string';

	return $async(() =>
		EVENT_BUS.post(['createEditor'], {
			noVerify: skipVerify,
			placeholder,
		}).then(([editor]) => {
			const dom = editor.dom;
			editor.onChange = onChange;

			const cb = () => {
				const val = unconscious(value);
				editor.setValue(isRawString ? val : inspect(val));
			};
			$watch(value, cb);
			$cleanup(dom, [value, cb]);
			return <div className="editor -inline col">{dom}</div>;
		}),
		() => <div className="editor jsonEditor" aria-busy="true">
			{generateSkeleton()}
		</div>
	);
};

/**
 *
 * @param {string} key
 * @param callback
 */
export function openJsonEditor(key, callback) {
	let w = getWindow(key);
	if (w) {
		focusWindow(w);
		return;
	}

	const editorState = $state();

	w = openWindow({
		id: "editor -json "+encodeURI(key),
		icon: <i className="ri-code-s-slash-line"></i>,
		title: "JSON 编辑器 #"+key,
		actions: <>
			<button className="btn -je" disabled={() => editorState.error} onClick={() => {
				data.value = inspect(editorState.obj);
			}}>
				<i className="ri-magic-line"></i> 格式化
			</button>
			<button className="btn -je" disabled={() => editorState.error} onClick={() => {
				setValue(editorState.obj);
			}}>
				<i className="ri-save-line"></i> 保存
			</button>
		</>,
		element: generateSkeleton,
	});
	const [data, setValue] = callback(w);

	EVENT_BUS.post(['createEditor']).then(([editor]) => {
		const dom = editor.dom;

		const cb = () => {
			const v = unconscious(data);
			editor.setValue(typeof v === 'string' ? v : inspect(v));
		};
		$watch(data, cb);
		$cleanup(dom, [data, cb]);
		editor.onChange = (text, obj, error) => {
			editorState.value = error ? {error} : {obj};
		};

		w.element.parentElement.replaceChildren(...dom);
	})
}