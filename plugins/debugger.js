import {EVENT_BUS} from "/src/states.js";
import {$cleanup, $state} from "unconscious";
import {inspect, INSPECT_ALL} from "@roj234/util-inspect";
import {openWindow} from "/src/components/Windows.jsx";
import {generateEditorSkeleton} from "/src/components/JsonEditor.jsx";
import {prettyError} from "/src/utils/utils.js";
import {emulateConsole} from "@roj234/workerbox/console";
import {formatDate} from "unconscious/common/Utils.js";
import {callCreateEditor} from "../src/utils/preview-bridge.js";

const console = window.console;
const logBuffer = $state([]);
let currentOutput;
const pushLog = log => {
	const timeNow = formatDate('H:i:s');
	const message = `[${timeNow}] `+log;
	console.warn(message);
	logBuffer.push(...message.split('\n'));
	if (currentOutput) currentOutput.append('\n'+message);
	while (logBuffer.length >= 1500) logBuffer.splice(0, 500);
};
window.console = emulateConsole(({log}) => pushLog(log))[0];

const F12 = async () => {
	let code = '';
	let output;
	const state0 = $state(generateEditorSkeleton());
	const state1 = $state(generateEditorSkeleton());
	const AsyncFunction = (async() => {}).constructor;

	const x = openWindow({
		id: "editor",
		icon: <i className="ri-code-s-slash-line"></i>,
		title: "控制台",
		actions: <>
			<button className="btn -je" onClick={async () => {
				try {
					const result = await AsyncFunction(code)();
					pushLog(inspect(result, INSPECT_ALL));
				} catch (e) {
					pushLog(prettyError(e));
				}
			}}>
				<i className="ri-code-s-line"></i> 运行
			</button>
		</>,
		element: () => {
			return <>
				{state0}
				{state1}
			</>
		},
	});

	// input
	callCreateEditor({
		noVerify: true,
		language: "javascript",
		placeholder: "在此处输入代码"
	}).then((editor) => {
		const dom = editor.dom;
		editor.onChange = (text) => code = text;
		editor.setValue("");
		state0.value = <div className="editor -inline col">{dom}</div>;
	});

	// output
	callCreateEditor({
		noVerify: true,
		language: "javascript",
		readOnly: true
	}).then((editor) => {
		const dom = editor.dom;

		currentOutput = editor.editor;
		$cleanup(dom, () => {
			currentOutput = null;
		});
		editor.setValue(logBuffer.join('\n'));
		output = editor;
		state1.value = dom[0];
	});
};

EVENT_BUS.on(['getMenu', 'dev'], items => {
	items.push(
		{ icon: "ri-code-s-slash-line", label: "控制台", act: F12 }
	);
})
