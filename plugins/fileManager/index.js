import {EVENT_BUS, selectedConversation} from "/src/states.js";
import {unconscious} from "unconscious";
import {callFileSystemFunc, createFileSystem, getFileSystem} from "../agent/index.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {GLOBAL_SETTINGS} from "/src/settings.js";
import {prefixTitle, registerToolset} from "/src/toolset.js";
import {normalizePath} from "@roj234/shared/path";
import {onLoad} from "/src/hooks.js";
import {PROMISE_CATCH} from "/common/pure-utils.js";

GLOBAL_SETTINGS.push({
	id: "trustHTML",
	type: "radio",
	required: true,
	name: "自动信任HTML",
	_tab: "customize",
	choices: {
		"否": false,
		"是": true
	}
})

COMMAND_REGISTRY["upload"] = [
	() => EVENT_BUS.post(['viewUrl'], ''),
	"在当前对话的工作区创建文件"
];

EVENT_BUS.on('resolveUrl', async (path, _, fs) => {
	if (fs == null) {
		const conv = unconscious(selectedConversation);
		if (!conv) return;
		[path, fs] = await getFileSystem(path, conv);
	}

	const url = new URL(path, 'http://0');
	return callFileSystemFunc(fs, 'readRaw', { path: decodeURIComponent(url.pathname.slice(1)) }).then(blob => blob.toUrl());
});

EVENT_BUS.on('viewUrl', async (path, _, node, fs) => {
	if (fs == null) {
		const conv = unconscious(selectedConversation);
		if (!conv) return;
		[path, fs] = await getFileSystem(path, conv);
	}

	const url = new URL(path, 'http://0');
	return (await import("./preview.js")).vfsPreview(fs, decodeURIComponent(url.pathname.slice(1)), node?.textContent);
});

/**
 * @type {AiChat.FunctionTool}
 * @private
 */
const RevealPath = {
	name: "RevealPath",
	description: "打开资源管理器窗口，向用户展示一个文件夹或其中的文件。这是一个打断操作：会打开窗口。",
	requireUI: true,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Folder path relative to workspace.", },
			file: { type: "string", description: "Optional file name to highlight" },
		},
		required: ["path"]
	},

	title: prefixTitle("打开"),
	async script({path, file}, ctx, conv) {
		let fs;
		[path, fs] = await getFileSystem(path, conv);
		await (await import("./preview.js")).vfsPreview(fs, normalizePath(path).join('/'));
		return 'Opened';
	}
}

registerToolset("RevealPath", "让AI给你打开文件夹", [RevealPath], {
	hidden: "manual"
});

// UI
onLoad(() => {
	const pos = document.querySelector("aside.sidebar .ri-wrench-line").parentElement;
	pos.insertBefore(<button className={"ri-folder-open-line btn ghost"} title="管理文件系统" onClick={() => createFileSystem({
		fs_label: "管理文件系统",
		_noupdate: true
	}).then((fs) => {
		return EVENT_BUS.post(['viewUrl'], '', null, fs);
	}, PROMISE_CATCH)} />, pos.lastElementChild);
});