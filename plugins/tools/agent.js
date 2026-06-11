import {ContentPart, registerTools} from "/src/skills.js";
import {config, selectedConversation} from "/src/states.js";
import {SETTINGS} from "/src/settings.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {unconscious} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {createWebFileSystem} from "./WebFileSystem.js";
import "./agent.css";

let opfsInstance;
/** @type {Map<string, WebFileSystemInstance>} */
const webFileSystemInstances = new Map;

SETTINGS.push({
	id: "fs_server",
	_tab: "tools",
	name: "[fs] 文件访问服务",
	title: "提供文件访问和命令执行功能",
	type: "input",
	pattern: /^(\/|https?:\/\/)/,
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

const directoryPickerAvailable = window.showDirectoryPicker;

/**
 * 调用 File Browser Interface (FBI) 选择文件系统实现
 * 这绝对不是我瞎编的接口！
 * @param {AiChat.Conversation} globalStorage
 * @return {Promise<WebFileSystemInstance>}
 */
async function callFBI(globalStorage) {
	let {fs_type, fs_base} = globalStorage;
	if (!fs_type) {
		fs_type = await new Promise((resolve, reject) => {
			const el = SimpleModal({
				title: "少年，与文件系统签订契约吧！",
				message: (
					<div className={"file-protocols agent-popup"}
						 onClick.delegate{"button"}={({delegateTarget}) => {
							el.remove();
							resolve(delegateTarget.className);
					}}>
						<div>
							<button disabled={!config.fs_server} className={"api"}
									title={"后端的独立文件访问模式(见Readme.md)"}>🐳 缚印
							</button>
							<span>缚于容器，如囚于笼，可运行万般程序。<br/>务必置于容器之内，方得施展。</span>
						</div>
						<div>
							<button disabled={!directoryPickerAvailable} className={"local"}
									title={"浏览器的showDirectoryPicker API\n不支持火狐"}>📁 启门
							</button>
							<span>推开现世之扉，直抵本地文件。<br/>浏览器亲自操刀，无有阻隔。</span>
						</div>
						<div>
							<button className={"config"} disabled={true} title={"虚拟化软件数据为文件"}>📜 化卷</button>
							<span>化数据为卷，供AI濡墨批阅。<br/>含配置、对话、预设、角色卡等，唯API Key隐去。慎之，隐私如玉！</span>
						</div>
						<div>
							<button className={"opfs"} title={"实验性"}>🌀 藏渊</button>
							<span>藏于虚空，浏览器私库（OPFS），<br/>数据栖于斯，暂未可导出。</span>
						</div>
					</div>
				),
				confirmMessage: "容后再议",
				accent: "ghost",
				onConfirm() {
					reject("User aborted the request")
				},
				onCancel: null,
			});
		});

		if (fs_type === "api") {
			fs_base = await new Promise(resolve => {
				SimpleModal({
					type: "input",
					title: "🐳 缚印·定域",
					message: (
						<div className={"md"}>
							<p>既择“缚印”之道，须划定<ruby>疆界<rt>工作目录</rt></ruby>。容器之根为 <kbd>/</kbd>，然天道不可直取，当择一<span className="highlight"><ruby>子域<rt>子目录</rt></ruby></span>以安天下。</p>
							<p>例：<kbd>/my-project-1</kbd>，勿授全根，慎之。</p>
							<p>此域日后仍可易之，入命<kbd>/basepath &lt;path&gt;</kbd> 即可<ruby>改弦更张<rt>更改路径</rt></ruby>。</p>
							<q>⚠️ <ruby>令咒<rt>命令</rt></ruby>可越藩篱，若于异容器中运行服务，则无此隐忧</q>
						</div>
					),
					value: "/",
					confirmMessage: "定此域",
					accent: "primary",
					onConfirm(value) {
						resolve(value === '/' ? '' : value);
					},
					onCancel: null
				});
			});

			if (fs_base) globalStorage.fs_base = fs_base;
			else delete globalStorage.fs_base;
		}
	}

	globalStorage.fs_type = fs_type;
	switch (fs_type) {
		case "api": return apiFileSystem;
		case "local": {
			const fs = webFileSystemInstances.get(fs_base);
			if (!fs) {
				return new Promise((resolve, reject) => {
					const onClick = () => {
						directoryPickerAvailable({
							id: APP_NAME+"_agent_root",
							mode: "readwrite"
						}).then(handle => {
							const folderName = handle.name;
							if (!folderName) throw "选择的文件夹没有名称";

							const fs = createWebFileSystem(handle);
							webFileSystemInstances.set(folderName, fs);
							if (globalStorage.fs_base !== folderName) {
								globalStorage.fs_base = folderName;

								SimpleModal({
									title: "📁 启门·立新约",
									message: (
										<div className={"md"}>
											<p>新门已立，名曰：<q>“{folderName}”</q>。</p>
											<p>
												日后每次归返，须<q><ruby>择同一门<rt>选择相同文件夹</rt></ruby></q>，方可再入此间。
												倘误闯他门，则前尘尽断，无可追忆。
											</p>
											<em>
												——<i>“今之所择为 <b>{folderName}</b>，来日亦当如是。”</i>
											</em>
										</div>
									),
									confirmMessage: `允`,
									accent: 'ghost',
									onCancel: null
								});
							}
							return fs;
						}).then(resolve).catch(reject).finally(() => el.remove());

						return false;
					};

					if (!fs_base && !webFileSystemInstances.size) {
						onClick();
						return;
					}

					const el = SimpleModal({
						title: "📁 启门·忆旧径",
						message: (
							    <div className="md" style={"position: relative"}>
									{fs_base && <blockquote>
										曾启之门「<q>{fs_base}</q>」<ruby>虽铭于心，却未寻得实径<rt>浏览器文件系统刷新后失效</rt></ruby>。
									</blockquote>}
									{webFileSystemInstances.size && <p>{fs_base ? "若欲改投他门，可叩下方已存之门扉；": "故门仍在，一触即入，旧卷悉陈。"}</p>}
									<div className={"agent-popup"} style={{
										display: "flex",
										"flex-wrap": "wrap",
										gap: "0.5rem"
									}}>
										{Array.from(webFileSystemInstances.entries()).map(([name, instance]) => (
											<div className="option" key={name}>
												<button className="btn ghost"
														onClick={() => {
															el.remove();
															resolve(instance);
														}}>
													📂 {name}
												</button>
											</div>
										))}
									</div>
									<p style={"text-align:right"}>{fs_base ? "唤「启新门」重择之。" : "推开现世之扉，另定一域。"}</p>
								</div>
						),
						confirmMessage: "🚪 启新门",
						accent: "primary",
						onConfirm: onClick,
						onCancel: null
					});
				})
			}

			return fs;
		}
		case "opfs": return opfsInstance || (opfsInstance = createWebFileSystem(await navigator.storage.getDirectory()));
		// not implemented
		case "config": break
	}
}

const apiFileSystem = async (func, parameters, globalStorage) => {
	let baseUrl = (import.meta.env.DEV ? config.fs_server || "/api" : config.fs_server);
	if (baseUrl.endsWith('/')) baseUrl += '/';

	let url = baseUrl+"fs/"+func;

	const {fs_base} = globalStorage;
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
}

const callAPI = (func) => async (parameters, _, globalStorage) => {
	let fs = globalStorage ? await callFBI(globalStorage) : apiFileSystem;

	if (typeof fs === 'function') return fs(func, parameters, globalStorage);

	const handler = fs[func];
	if (!handler) throw `Function ${func} is not implemented`;
	return handler(parameters);
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
	description: "Patch one to multiple ranges in a file using anchors. " +
		"Each patch modifies the interval [start_anchor, end_anchor]. " +
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
						start_anchor: { type: "string" },
						end_anchor: { type: "string" },
						content: { type: "string" },
					},

					required: ["start_anchor", "end_anchor", "content"]
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
			start_line: { type: "number" },
			end_line: { type: "number" },
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
const run_program = {
	name: "run_program",
	description: "Execute a program with an array of arguments.",
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
			cwd: {
				type: "string",
				default: ".",
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
/** @type {AiChat.FunctionTool} */
const shell = {
	name: "shell",
	description: "Run a command string through a shell.",
	interactive: "secure",
	script: callAPI("shell"),

	parameters: {
		type: "object",
		properties: {
			description: { type: "string" },
			command: { type: "string", },
			cwd: {
				type: "string",
				default: ".",
			},
			timeout: {
				type: "integer",
				default: 10,
				maximum: 120,
				description: "(in seconds)"
			}
		},
		required: ["description", "command"]
	}
};

let fsPrompt = `<file-tools>
Grep pattern in list_directory tool may be used to recursively list directory.
Root path is '.', always use relative path.
</file-tools>`;
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

2. **Patch**: Use \`patch\` with arrays of:
   - \`start_anchor\`: first line to replace (inclusive).
   - \`end_anchor\`: last line to replace (inclusive).
   - \`content\`: replacement lines.

Response example:

\`\`\`
[Patch 1]
8#90b8	倒数第二行
[Patch 2]
9#1fa9	最后一行
\`\`\`

- Return new anchors for changed lines. Untouched lines keep their original anchors; their line numbers shift by the cumulative diff.
- You MUST chain multiple patches in one patch call to avoid mangle anchors.

## String‑based editing

Use \`replace\` when you have an exact string to swap once. The \`search\` must **exactly occurrence once** in the file.

To disambiguate when the search string appears multiple times, narrow the scope with:
- \`start_line\` / \`end_line\` (inclusive) — restrict the search to that line range.

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
	if (!config.fs_server) throw '请配置基于后端的文件访问服务';
	return tools;
}

registerTools(
	"run_program",
	"Run native programs / commands for package managers, builds, tests, scripts, etc. Use only when command-line execution is required.",
	[run_program, shell],
	{
		onActivated: checkEnv,
		async systemPrompt() {
			let shellInfo = '';

			if (!spawnPrompt) {
				checkEnv();

				let {prompt} = await callAPI("env")();
				if (prompt.startsWith("os: Windows")) {
					if (!prompt.includes("bash: No")) {
						shellInfo = "emulated bash";
					} else {
						shellInfo = "powershell\n   - Powershell have many escape and encoding issues. Use script file if available."
					}
				} else {
					shellInfo = 'bash';
				}
				if (!prompt.includes("ripgrep: No")) {
					prompt += "\n\nYou may use \`rg\` (ripgrep) to find in files.";
				}
				spawnPrompt = `<system-environment>
Environment and runtimes:
${prompt}
</system-environment>
<command-execution>
Two tools are available for running commands in the sandbox:

1. **run_program** — Execute a program with an array of arguments.
   - Escaping-safe (no shell interpretation), ideal for complex arguments.
   - Use for: package managers (npm, pip, cargo), compilers, interpreters (python, node, java), tests, builds.

2. **shell** — Run a command string through a shell.
   - Use when you need pipelines (\`|\`), redirections (\`>\`, \`<\`, \`2>&1\`), chaining (\`&&\`, \`||\`), or shell syntax.
   - Shell: ${shellInfo}

**Guidelines**
- Prefer a reusable script file (Python, JS, shell, etc.) over repeating near-same commands.
- Use \`run_program\` when you don't need shell features (safer, no escaping pitfalls).
- Use \`shell\` only when you must: pipelines, redirections, chaining, or shell built-ins.
- Always use relative path.
- Working directory defaults to \`/\`; timeout max 120 seconds.
- Large output will be redirected to files.
</command-execution>`;
			}
			return spawnPrompt;
		}
	}
);