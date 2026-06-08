import {ContentPart, registerTools} from "/src/skills.js";
import {config, selectedConversation} from "/src/states.js";
import {SETTINGS} from "/src/settings.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {unconscious} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {createWebFileSystem} from "./WebFileSystem.js";

/** @type {FileSystemDirectoryHandle} */
let webFileSystem;
async function initWebFileSystem() {
	const rootHandle = await showDirectoryPicker({
		id: APP_NAME+"_agent_root",
		mode: "readwrite"
	});
	webFileSystem = createWebFileSystem(rootHandle);
}

SETTINGS.push({
	id: "fs_server",
	_tab: "tools",
	name: "[fs] 文件访问服务",
	title: "提供文件访问和命令执行功能",
	type: "input",
	pattern: /^(\/|https?:\/\/)|^:browser:$/,
	warning: "请输入合法的API端点",
	placeholder: "http://localhost:1/api/"
}, {
	_tab: "tools",
	name: "[fs] 工具配置",
	type: "multiple",
	choices: {
		"使用 HashLine 编辑文件": "fs_hashline"
	},
	title: {
		"使用 HashLine 编辑文件": "HashLine让模型使用稳定的锚点进行文件编辑\n然而因为模型并未在这种格式的数据上训练，它可能只是跑分好看\n刷新页面生效"
	}
});

COMMAND_REGISTRY["basepath"] = [
	(args) => {
		const conv = unconscious(selectedConversation);
		if (!conv) return;
		const firstArg = args[0];
		if (!firstArg) delete conv.fs_base;
		else conv.fs_base = firstArg;
		showToast("文件根目录已设置为 /"+(firstArg || ""));
	},
	"设置文件访问服务的根目录"
];

const callAPI = (func, type = 'fs') => async (parameters, _, globalStorage = {}) => {
	let baseUrl = (import.meta.env.DEV ? config.fs_server || "/api" : config.fs_server);
	const useWebFileSystem = !baseUrl || baseUrl === ':browser:';
	if (useWebFileSystem) {
		if (!baseUrl) {
			const useBrowser = await new Promise(resolve => {
				SimpleModal({
					title: "未配置文件访问服务",
					message: "确认：使用浏览器文件系统API\n取消：填写文件访问服务地址后重新请求",
					onConfirm(){config.fs_server = ':browser:';resolve(true)},
					onCancel(){resolve(false)}
				})
			});
			if (!useBrowser) throw '请配置文件访问服务'
		}

		if (!webFileSystem) await initWebFileSystem();
	} else if (!baseUrl.endsWith('/')) baseUrl += '/';

	if (func === "read_image") {
		if (!config.modalities.includes("image")) {
			return {error: "You don't have [image] modality. Ask user to enable if you do have."}
		}
	}

	const {fs_base} = globalStorage;

	if (useWebFileSystem) {
		if (fs_base) throw '浏览器文件系统暂不支持子目录隔离';
		return webFileSystem[func](parameters);
	}

	let url = baseUrl + type + "/" + func;
	if (fs_base) url += "?root="+encodeURIComponent(fs_base);

	let response;
	try {
		response = await fetch(url, {
			method: parameters ? 'POST' : 'GET',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(parameters)
		});
	} catch (e) {
		throw "network error";
	}

	if (!response.ok) throw (await response.text());

	const content = response.headers.get("content-type") || "";
	if (content.startsWith("image/")) return new ContentPart().image(await response.blob());
	if (content === ("application/json")) return await response.json();
	return await response.text();
};

/** @type {AiChat.FunctionTool} */
const list_path = {
	name: "list_directory",
	description: "List directory",
	script: callAPI("list"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			glob: {
				type: "string",
				description: "Glob pattern",
			}
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const read_file = {
	name: "read_file",
	description: "Read file as text",
	script: callAPI("read"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			format: {
				type: "string",
				enum: ["raw", "line_number"],
				description: "prefixed result with `line + \\t + content`"
			},
			start: {
				type: "integer",
				description: "start line (1-based, inclusive)",
			},
			end: {
				type: "integer",
				description: "end line (inclusive)",
			},
			max_chars: {
				type: "integer",
				default: 32768,
				description: "maximum total characters to read; output is truncated to complete lines."
			}
		},
		required: ["path", "format"]
	}
};
/** @type {AiChat.FunctionTool} */
const read_image = {
	name: "read_image",
	description: "Load an image file from the workspace so it can be inspected visually.",
	script: callAPI("read_image"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const write_file = {
	name: "write",
	description: "Overwrite a file",
	script: callAPI("write"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			content: { type: "string" },
			/*lines: {
				type: "array",
				items: { type: "string" }
			}*/
		},
		required: ["path", "content"]
	}
};
/** @type {AiChat.FunctionTool} */
const patch_file = {
	name: "patch",
	description: "Patch ranges in a file using anchors. " +
		"Each patch modifies the interval [start_anchor, end_anchor). " +
		"If start == end, then new lines are inserted before that point. " +
		"Anchor format is \"line#hash\"",
	script: callAPI("patch"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			patches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						start_anchor: {
							type: "string",
							description: "inclusive"
						},
						end_anchor: {
							type: "string",
							description: "exclusive. Use \"#EOF\" for EOF"
						},
						lines: {
							type: "array",
							items: { type: "string" }
						},
					},

					required: ["start_anchor", "end_anchor", "lines"]
				}
			}
		},
		required: ["path", "patches"]
	}
};
/** @type {AiChat.FunctionTool} */
const replace_file = {
	name: "replace",
	description:
		"Find and replace a single occurrence of a file within a optional range. " +
		"The search string must occurrence exactly once in the range. "+
		"Set `all` to true to replace every match in the range instead of just one.",
	script: callAPI("replace"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			search: { type: "string" },
			replace: { type: "string" },
			start_line: { type: "number", description: "inclusive" },
			end_line: { type: "number", description: "exclusive" },
			all: { type: "boolean", default: false }
		},
		required: ["path", "search", "replace"]
	}
};
/** @type {AiChat.FunctionTool} */
const mkdir = {
	name: "mkdir",
	description: "Create directory recursively",
	script: callAPI("mkdirs"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const copy_or_move = {
	name: "copy_or_move",
	description: "Copy or move file/directory",
	script: callAPI("copy"),

	parameters: {
		type: "object",
		properties: {
			src: { type: "string", },
			dest: { type: "string", },
			move: { type: "boolean", description: "delete src after copy" }
		},
		required: ["src", "dest"]
	}
};
/** @type {AiChat.FunctionTool} */
const delete_file = {
	name: "delete",
	description: "Delete file/directory recursively",
	script: callAPI("delete"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const stat = {
	name: "stat",
	description: "Read file metadata (size, last modified, etc.)",
	script: callAPI("stat"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};

/** @type {AiChat.FunctionTool} */
const spawn = {
	name: "run_process",
	description: "Run a native process in the sandbox. Use for build commands, tests, package manager commands, project scripts, external executables, etc.",

	interactive: "secure",
	script: callAPI("spawn"),

	parameters: {
		type: "object",
		properties: {
			description: { type: "string" },
			program: { type: "string", },
			arguments: {
				type: "array",
				items: {
					type: "string",
				}
			},
			directory: {
				type: "string",
				default: ".",
				description: "Working directory",
			},
			timeout: {
				type: "integer",
				default: 10,
				maximum: 120,
				description: "(in seconds)"
			}
		},
		required: ["description", "program", "arguments"]
	}
};

let fsPrompt = `<file-misc>
You may use bash/ripgrep via run_process tool to find in files.
Grep pattern in list_directory tool may be used to recursively list directory.
Root path is '/'
</file-misc>`;
const fsTools = [read_file, read_image, write_file, replace_file, delete_file, mkdir, copy_or_move, list_path, stat];
if (config.fs_hashline) {
	read_file.parameters.properties.format = {
		type: "string",
		enum: ["raw", "line_number", "anchors"]
	}
	replace_file.description +=
		" Use this for simple, one-shot substitutions." +
		" For multi‑edit, insertions, deletions, or when you can't guarantee a unique match, use `patch` with anchors instead.";

	fsTools.push(patch_file);
	fsPrompt += `<file-edit-guide>
For all file editing, use read_file + patch (anchor‑based) or replace (string‑based).

## Reading files

Call \`read_file\` with one of three formats:

- **\`raw\`** — plain text, no metadata. Use for quick inspection when you don't need line‑level precision.
- **\`line_number\`** — content prefixed with \`N\\t\`. Lightweight: use to scan structure, locate edits, or pair with \`replace\`'s \`start_line\`/\`end_line\`. Cheaper than \`anchors\` (no hash overhead).
- **\`anchors\`** — content prefixed with \`N#hash\\t\`. Required before \`patch\`. Hash anchors let \`patch\` survive line‑number shifts from earlier edits.

**Strategy**: explore with \`line_number\` first (lower token cost). Switch to \`anchors\` only when you're ready to call \`patch\`.

## Anchor‑based editing (preferred for multi‑edit, insertions, or large files)

1. **Read with anchors**: Call \`read_file\` with \`format: anchors\`. The response looks like:

\`\`\`
1#fdb1	content
...
1234#e7b7	test
[TRUNCATED: 1234 of 5678 lines shown]
\`\`\`

The anchor is \`1#fdb1\` and \`1234#e7b7\`.

Without \`anchors\` format, you cannot use \`patch\`.

2. **Plan your edit**: Decide the range to replace or insertion point.
3. **Patch**: Use \`patch\` with arrays of:
   - \`start_anchor\`: first line to replace (inclusive).
   - \`end_anchor\`: line **after** the last line to replace (exclusive). Use \`"#EOF"\` for end‑of‑file.
   - Set \`start_anchor == end_anchor\` to **insert** before that line.
   - \`lines\`: array of replacement lines (empty array to delete).

Response example:

\`\`\`
[Patch 1]
Range: [8, 8)
New lines: 2 (+2)
[Content with anchors]
8#90b8	倒数第二行
9#1fa9	最后一行
\`\`\`

- \`Range: [8, 8)\` means start == end → insertion (0 lines replaced).
- New anchors are returned for changed lines only. Untouched lines keep their original anchors; their line numbers shift by the cumulative diff.
- You MUST chain multiple patches in one patch call to avoid re‑reading / mangle anchors.

## String‑based editing (for one‑shot find‑and‑replace)

Use \`replace\` when you have an exact string to swap once. The \`search\` must match **exactly one occurrence** in the file.

To disambiguate when the search string appears multiple times, narrow the scope with:
- \`start_line\` (inclusive) / \`end_line\` (exclusive) — restrict the search to that line range.

Typical workflow: \`read_file(format: "line_number")\` → spot the line number → \`replace(search=..., replace=..., start_line=42, end_line=42)\`.

## Guideline
- Use \`read_file(format: "line_number")\` for exploration — cheaper than \`anchors\`.
- Use \`patch\` for structural changes, multi‑line edits, insertions, or deletions.
- Use \`replace\` only for single, unambiguous find‑and‑replace.
</file-edit-guide>`;
}

registerTools(
	"workspace_files",
	"Read, write, list, create, rename, and delete files in the workspace.",
	fsTools,
	{ systemPrompt: fsPrompt }
);

let spawnPrompt;

function checkEnv(tools) {
	const fsServer = config.fs_server;
	if (!fsServer) throw '请配置文件访问服务';
	if (fsServer === ':browser:') throw '浏览器文件系统不支持运行程序';
	return tools;
}

registerTools(
	"run_process",
	"Run native commands for package managers, builds, tests, scripts, etc. Use only when command-line execution is required.",
	[spawn],
	{
		onActivated: checkEnv,
		async systemPrompt() {
			if (!spawnPrompt) {
				checkEnv();

				let {prompt} = await callAPI("env")();
				if (prompt.startsWith("os: Windows")) {
					if (!prompt.includes("bash: No")) {
						prompt += "\nbash is emulated via msys/busybox.";
					}
					prompt += "\n\nIMPORTANT: PowerShell and cmd have many escape and encoding issues (like '\\'). Use bash / script file if available."
				}
				spawnPrompt = `<environment-info>
Environment and runtimes:
${prompt}

Use script file (py / js / java, etc) if run_process tool doesn't fulfill your need.
</environment-info>`;
			}
			return spawnPrompt;
		}
	}
);