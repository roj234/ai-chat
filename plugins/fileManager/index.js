import {config, EVENT_BUS, selectedConversation} from "/src/states.js";
import {unconscious} from "unconscious";
import {callFileSystemFunc, createFileSystem, getFileSystem} from "../agent/index.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {GLOBAL_SETTINGS} from "/src/settings.js";
import {prefixTitle, registerToolset} from "/src/toolset.js";
import {normalizePath} from "@roj234/shared/path";
import {onLoad} from "/src/hooks.js";
import {PROMISE_CATCH} from "/common/pure-utils.js";

EVENT_BUS.on(['getMenu', 'dev'], items => {
	const set = config.trustHTML;
	items.push({ icon: set ? "ri-checkbox-line" : "ri-checkbox-blank-line", label: "信任所有 HTML 脚本", danger: !set, act: () => config.trustHTML ^= 1 })
})

GLOBAL_SETTINGS.push({
	id: "trustHTML",
	type: "radio",
	_tab: "hide",
	required: true,
	choices: {
		"否": 0,
		"是": 1
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

EVENT_BUS.on('jsonEditor', async (skipVerify) => (await import("./preview.js")).createJson5Editor(skipVerify));

/**
 * @type {AiChat.FunctionTool}
 * @private
 */
const OpenFile = {
	name: "OpenFile",
	description: "用默认程序打开文件/文件夹，若提供 file，则在 path 文件夹中高亮它",
	requireUI: true,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
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
};

registerToolset("OpenFile", "让AI给你打开文件夹", [OpenFile], {
	hidden: "manual"
});

// UI
onLoad(() => {
	const pos = document.querySelector("aside.sidebar .ri-wrench-line").parentElement;
	pos.insertBefore(<button className={"ri-folder-open-line btn ghost"} title="管理文件系统" onClick={() => createFileSystem({
		fs_label: "选择要管理的文件系统",
		_noupdate: true
	}).then((fs) => {
		return EVENT_BUS.post(['viewUrl'], '', null, fs);
	}, PROMISE_CATCH)} />, pos.lastElementChild);
});