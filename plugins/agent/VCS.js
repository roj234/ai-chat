import {getToolParameters, prefixTitle, registerToolset} from "/src/toolset.js";
import {selectedConversation} from "/src/states.js";
import {unconscious} from "unconscious";
import {callFileSystemFunc, getFileSystem,} from "./Mounts.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {
	VCS_BASE_BRANCH,
	VCS_COMMIT,
	VCS_DIFF,
	VCS_LIST_BRANCHES,
	VCS_QUERY,
	VCS_REVERT,
	VCS_SWITCH
} from "./VCS_shared.js";
import {showVCSDialog} from "./VCS_dialog.js";
import {renderMarkdownToElement} from "/src/markdown/markdown.js";

/** @type {AiChat.FunctionTool} */
const Overlays = {
	name: "Overlays",
	description: `List overlays (staging areas) on specified VFS. They are ".0V3R1ay_"-prefixed hidden folders inside base \`${VCS_BASE_BRANCH}\`.`,
	parameters: {
		type: "object",
		properties: {
			vfs: { type: "string", default: "." }
		}
	},
	title: (req, ctx) => {
		const { vfs = '.' } = getToolParameters(ctx, req);
		return `列出覆盖层`+(vfs==='.'?'':` (${vfs})`);
	},
	async script({ vfs = "." }, resp, conv) {
		const [path, fsImpl] = await getFileSystem(vfs, conv);
		if (path && path !== '.') throw "fs must points to VFS root";
		return callFileSystemFunc(fsImpl, 'vcs', { mode: VCS_LIST_BRANCHES }, conv);
	},
};

/** @type {AiChat.FunctionTool} */
const Checkout = {
	name: "Checkout",
	description: `Switch to another overlay, create if not exist. Specify \`${VCS_BASE_BRANCH}\` to exit.`,
	parameters: {
		type: "object",
		properties: {
			name: { type: "string" },
			vfs: { type: "string", default: '.' },
		},
		required: ['name']
	},
	interactive(par, conv) {
		return par.name === VCS_BASE_BRANCH ? "secure" : null;
	},
	title: (req, ctx) => {
		const { name, vfs = '.' } = getToolParameters(ctx, req);
		return `切换到覆盖层 ${name}`+(vfs==='.'?'':` (${vfs})`);
	},
	async undo(ctx, conv, tc) {
		if (ctx.prev == null) return;

		const { vfs = "." } = getToolParameters(ctx, tc);
		const [path, fs] = await getFileSystem(vfs, conv);
		return callFileSystemFunc(fs, 'vcs', { mode: VCS_SWITCH, path: ctx.prev }, conv);
	},
	async script({ vfs = ".", name }, ctx, conv) {
		const [path, fs] = await getFileSystem(vfs, conv);
		if (path && path !== '.') throw "fs must points to VFS root";

		const prev = await callFileSystemFunc(fs, 'vcs', { mode: VCS_QUERY }, conv) ?? VCS_BASE_BRANCH;
		await callFileSystemFunc(fs, 'vcs', { mode: VCS_SWITCH, path: name }, conv);

		ctx.prev = prev;
		return `Active overlay: ${prev} -> `+name;
	},
};


/**
 * @type {AiChat.FunctionTool}
 */
const Status = {
	name: "Status",
	description: "List pending changes.",
	parameters: {
		type: "object",
		properties: {
			glob: { type: "string", default: "**" },
			limit: { type: "number", default: 100 },
		},
	},
	title: prefixTitle("查看暂存区", 'glob'),
	async script({ glob = '**', limit = 100 }, resp, conv) {
		const [rel, fs] = await getFileSystem(glob, conv);
		return callFileSystemFunc(fs, 'vcs', { mode: VCS_DIFF, path: rel, limit }, conv);
	},
};

/**
 * @type {AiChat.FunctionTool}
 */
const Merge = {
	name: "Merge",
	description: "Merge staged changes.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", default: "." },
			targetOverlay: { type: "string", default: VCS_BASE_BRANCH },
			summary: { type: "string", description: "Concise, user-facing summary in markdown." },
		},
		required: ["summary"]
	},
	interactive(par, conv) {
		return (par.targetOverlay ?? VCS_BASE_BRANCH) === VCS_BASE_BRANCH ? "secure" : null;
	},
	title: (req, ctx) => {
		const { path = '.', targetOverlay = VCS_BASE_BRANCH } = getToolParameters(ctx, req);
		return `合并 ${path} 覆盖层到 `+targetOverlay;
	},
	renderInput(ctx, el, tc) {
		if (ctx.success !== true) return false;
		const param = getToolParameters(ctx, tc);
		return renderMarkdownToElement(<div className="md"/>, param.summary);
	},
	async script({path = ".", targetOverlay = VCS_BASE_BRANCH, summary }, resp, conv) {
		const [rel, fs] = await getFileSystem(path, conv);
		return callFileSystemFunc(fs, 'vcs', { mode: VCS_COMMIT, path: rel, target: targetOverlay }, conv);
	},
};

/**
 * @type {AiChat.FunctionTool}
 */
const Revert = {
	name: "Revert",
	description: "Discard staged changes.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" }
		},
		required: ["path"]
	},
	title: prefixTitle("回滚", "path"),
	async script({ path }, resp, conv) {
		const [rel, fs] = await getFileSystem(path, conv);
		return callFileSystemFunc(fs, 'vcs', { mode: VCS_REVERT, path: rel }, conv);
	},
};

//endregion

export const vcsTools = [Overlays, Checkout, Merge, Revert, Status];
export const vcsEnabledKey = 'Files/VCS';

registerToolset(
	vcsEnabledKey,
	"简易版本控制.\n用 /vcs 打开 GUI",
	vcsTools,
	{
		hidden: 'manual',
		depend: ['Files'],
		//default: true,
	}
);

COMMAND_REGISTRY['vcs'] = [
	() => {
		showVCSDialog(unconscious(selectedConversation));
	},
	"打开分支管理窗口",
];
