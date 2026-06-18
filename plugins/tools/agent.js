import {ContentPart, getToolParameters, registerTools} from "/src/skills.js";
import {config, selectedConversation} from "/src/states.js";
import {SETTINGS} from "/src/settings.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {debugSymbol, unconscious} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {createWebFileSystem} from "./WebFileSystem.js";
import "./agent.css";
import {createConfigFileSystem} from "./ConfigFileSystem.js";
import {AskUser} from "./rp_kit/AskUser.js";

let opfsInstance;
/** @type {Map<string, AiChat.FileSystemInstance>} */
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

const FS_INSTANCE = debugSymbol("FS_INSTANCE");

/**
 * 调用 File Browser Interface (FBI) 选择文件系统实现
 * 这绝对不是我瞎编的接口！
 * @param {AiChat.Conversation} globalStorage
 * @return {Promise<AiChat.FileSystemInstance>}
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
							<button className={"config"} title={"虚拟化软件数据为文件"}>📜 化卷</button>
							<span>化数据为卷，供AI濡墨批阅。<br/>含配置、对话、预设、角色卡等，唯API Key隐去。<b style={"color:red"}>慎之，隐私如玉！</b></span>
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
		}
		if (fs_type === 'config') {
			fs_base = await new Promise((resolve, reject) => {
				SimpleModal({
					type: "input",
					title: "📜 化卷·圈地",
					message: (
						<div className={"md"}>
							<p>"化卷"之道，乃拟态软件数据为文牍。AI笔锋所至，皆可增删改易，故须<q>“先明其制，后授其权”</q>。</p>

							<p>卷中纲目如下：</p>
							<ul>
								<li><kbd>kv/</kbd> — <ruby>杂记<rt>键值存储</rt></ruby>，含<ruby>心念<rt>用户记忆</rt></ruby>、<ruby>画壁<rt>背景图</rt></ruby>等</li>
								<li><kbd>kvs/</kbd> — <ruby>法度<rt>预设</rt></ruby>与<ruby>命格<rt>角色卡</rt></ruby>汇于此</li>
								<li><kbd>conversations/</kbd> — <ruby>往昔言录<rt>对话记录</rt></ruby>，以<ruby>编年<rt>ID</rt></ruby>分卷</li>
								<li><kbd>config.json</kbd> — 当前<ruby>契约<rt>配置</rt></ruby></li>
							</ul>

							<p>若欲画地为牢，可于此填写<ruby>前导之径<rt>路径前缀</rt></ruby>：</p>
						</div>
					),
					placeholder: "⚠️ 若留空不填，则AI执掌全卷，无所不窥、无所不书。此权极重，慎之再慎。",
					after: (
						<div className={"md"}>
							<p>例：<kbd>kv/</kbd> — 则AI仅能涉足<q>杂记</q>一域，不得染指言录与法度。</p>
							<p>例：<kbd>conversations/652/</kbd> — 则仅可见<q>第652卷</q>，余者皆隐。</p>
							<blockquote style={"border-left-color: \#e55"}>
								<p>虽<ruby>印信<rt>API Key</rt></ruby>已被抹去，然卷中<strong style={"color: \#f66"}>言录历历、心念昭昭</strong>——汝之所思、所语、所忆，尽在其中。</p>
								<p>隐私如玉，碎之不可复全。<b style={"color: \#f66"}>数据无价，<ruby>谨慎操作<rt>他妈的给我备份！</rt></ruby>。</b></p>
								<p>——<i>“授人以笔，当知其可书亦可毁。”</i></p>
							</blockquote>
						</div>
					),
					confirmMessage: "定此疆界",
					onConfirm: resolve,
					onCancel() {
						reject("User aborted the request");
					},
				});
			});
		}

		if (fs_base) globalStorage.fs_base = fs_base;
		else delete globalStorage.fs_base;
	}

	globalStorage.fs_type = fs_type;
	switch (fs_type) {
		case "api": return apiFileSystem;
		case "local": {
			const fs = webFileSystemInstances.get(fs_base);
			if (!fs) {
				return new Promise((resolve, reject) => {
					let el;
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
						}).then(resolve).catch(reject).finally(() => el?.remove());

						return false;
					};

					if (!fs_base && !webFileSystemInstances.size) {
						onClick();
						return;
					}

					el = SimpleModal({
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
		case "config": return createConfigFileSystem(fs_base);
	}
}

const apiFileSystem = async (func, parameters, globalStorage) => {
	let baseUrl = (import.meta.env.DEV ? config.fs_server || "/api" : config.fs_server);
	if (!baseUrl.endsWith('/')) baseUrl += '/';

	let url = baseUrl+"fs/"+func;

	const fs_base = globalStorage?.fs_base;
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
	if (content.includes("application/json")) return await response.json();
	return await response.text();
}

export const fileAccess = (func) => async (parameters, _, globalStorage) => {
	let fs = globalStorage ? globalStorage[FS_INSTANCE] || (globalStorage[FS_INSTANCE] = await callFBI(globalStorage)) : apiFileSystem;

	const path = parameters.path || parameters.cwd;
	if (path?.[0] === '/') throw "path must be relative `./folder` or `folder`, never use absolute path `/`";

	if (typeof fs === 'function') return fs(func, parameters, globalStorage);

	const handler = fs[func];
	if (!handler) throw `[Unrecoverable error: ${func} not implemented in current filesystem]`;
	return handler(parameters);
};

export const prefixTitle = (prefix) => {
	return (req, ctx = {}) => {
		return prefix+' '+getToolParameters(ctx, req).path;
	};
}

/** @type {AiChat.FunctionTool} */
const Glob = {
	name: "Glob",
	description: "Execute glob pattern in \`path\`.\nReturn TSV rows [relative path, type (dir or file), size in bytes]",
	script: fileAccess("list"),
	title(req, ctx = {}) {
		const {path, glob = '*'} = getToolParameters(ctx, req);
		return glob !== "*"
			? "列出 " + path + "/" + glob
			: "列出 " + path;
	},

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			glob: { type: "string", default: "*" }
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const Read = {
	name: "Read",
	description: "Read text file by 1-based line `offset`." +
		" Negative `offset` count from the end." +
		" Return at most `limit` lines." +
		" Read(offset=-5) for a 10-line file return line 6-10" +
		" Read(offset=-5, limit=3) for that file return line 6-8",
	script: fileAccess("read"),
	title: prefixTitle("读取"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			format: {
				type: "string",
				enum: ["raw", "lineNumber"],
				description: "`lineNumber` will prefixed result with `line + \\t + content`"
			},
			offset: { type: "integer" },
			limit: { type: "integer" },
			maxChars: {
				type: "integer",
				default: 50000,
				description: "Maximum characters to return. Output will be truncated at the end of the last line that fits, every returned line is intact."
			}
		},
		required: ["path", "format"]
	}
};
/** @type {AiChat.FunctionTool} */
const ReadImage = {
	name: "ReadImage",
	description: "Load an image file to visually inspect it",
	script: fileAccess("readImage"),
	title: prefixTitle("查看图片"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const Write = {
	name: "Write",
	description: "Write or overwrite a file.",
	script: fileAccess("write"),
	title: prefixTitle("写入"),

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
const Append = {
	name: "Append",
	description: "Append to the end of a file. Non exist file will be created.",
	script: fileAccess("append"),
	title: prefixTitle("追加"),
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			content: { type: "string" },
			newline: {
				type: "boolean",
				default: true,
				description: "If true (default) and file is not empty, prepend \\n before content if not exist." +
					" Set to false to append content as-is without any modification."
			},
		},
		required: ["path", "content"]
	}
};
/** @type {AiChat.FunctionTool} */
const Patch = {
	name: "Patch",
	description: "Patch one to multiple ranges in a file using anchors. " +
		"Each patch modifies the interval [startAnchor, endAnchor]. " +
		"Anchor format is \"line#hash\"",
	script: fileAccess("patch"),
	title: prefixTitle("修改"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			patches: {
				type: "array",
				items: {
					type: "object",
					properties: {
						startAnchor: { type: "string" },
						endAnchor: { type: "string" },
						content: { type: "string" },
					},

					required: ["startAnchor", "endAnchor", "content"]
				}
			}
		},
		required: ["path", "patches"]
	}
};
/** @type {AiChat.FunctionTool} */
const Edit = {
	name: "Edit",
	description:
		"Find and replace text within a file in an optional 1-based line range." +
		" When `replaceAll` is true, replaces all occurrences in that range." +
		" when `replaceAll` is false, it must occur exactly once in that range.",
	script: fileAccess("edit"),
	title: prefixTitle("修改"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			search: { type: "string" },
			replace: { type: "string" },
			startLine: { type: "integer" },
			endLine: { type: "integer" },
			replaceAll: { type: "boolean", default: false }
		},
		required: ["path", "search", "replace"]
	}
};
/** @type {AiChat.FunctionTool} */
const Mkdirs = {
	name: "Mkdirs",
	description: "Create directory recursively",
	script: fileAccess("mkdirs"),
	title: prefixTitle("创建"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const CopyMove = {
	name: "CopyMove",
	description: "Copy file/directory, move them when `move` is true",
	script: fileAccess("copy"),
	title(req, ctx = {}) {
		const toolParameters = getToolParameters(ctx, req);
		return (toolParameters.move?"移动":"复制") + ' ' + toolParameters.src + ' 到 ' + toolParameters.dest;
	},

	parameters: {
		type: "object",
		properties: {
			src: { type: "string", },
			dest: { type: "string", },
			move: { type: "boolean", default: false }
		},
		required: ["src", "dest"]
	}
};
/** @type {AiChat.FunctionTool} */
const Delete = {
	name: "Delete",
	description: "Delete file/directory recursively",
	script: fileAccess("delete"),
	title: prefixTitle("删除"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};
/** @type {AiChat.FunctionTool} */
const Stat = {
	name: "Stat",
	description: "Read path type, lastModified and size (if is file).",
	script: fileAccess("stat"),
	title: prefixTitle("读元数据"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};

const MAX_LINE_LENGTH = 180;

/** @type {AiChat.FunctionTool} */
const Grep = {
	name: "Grep",
	description: `Search for a regex pattern across files in a directory.`,
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regular expression pattern" },
			path: { type: "string", default: "." },
			glob: { type: "string", default: "**" },
			maxResults: { type: "integer", default: 50, minimum: 1, maximum: 500 },
		},
		required: ["pattern"],
	},

	title(req, ctx = {}) {
		const {pattern, path = '.', glob = '**'} = getToolParameters(ctx, req);
		const p = pattern.length > 30 ? pattern.slice(0, 30) + "…" : pattern;
		return "搜索 " + (glob !== "**" ? path + "/" + glob : path) + " 中的 " + p;
	},
	script: async ({ pattern, path = ".", glob = "**", maxResults = 50 }, response, conv) => {
		if (conv.fs_type === "api") {
			try {
				const spawn = fileAccess("spawn");

				let result = await spawn({
					program: "rg",
					arguments: [
						"--line-number",
						"--no-messages",
						"--heading",
						"--max-columns", MAX_LINE_LENGTH,
						"--color", "never",
						"--max-count", maxResults,
						"--glob", glob,
						"--path-separator", "/",
						"--",
						pattern,
						path,
					],
					// return full content, hidden parameter
					noTruncate: true,
					timeout: 30,
				}, response, conv);

				if (!result.startsWith("Exit code -1")) {
					result = result.slice(result.indexOf('\n')+1);
					return result.split("\n\n").map(item => item.slice(path.length+1)).slice(0, maxResults).join("\n\n") || '[No match]';
				}
			} catch (e) {
				showToast("未找到后端的rg/ripgrep工具，可能影响性能\n"+e, 'error');
			}
		}

		const list = fileAccess("list");
		const read = fileAccess("read");

		let flag = '';
		if (pattern.startsWith("(?")) {
			const end = pattern.indexOf(')');
			flag = pattern.slice(2, end);
			pattern = pattern.slice(end+1);
		}
		const regExp = new RegExp(pattern, flag);

		let results = '';
		let matches = 0;

		const concurrency = 6;
		const taskQueue = new Set;

		const enqueue = async runTask => {
			while (taskQueue.size >= concurrency) {
				await Promise.race(taskQueue);
			}

			const self = runTask().finally(() => taskQueue.delete(self));
			taskQueue.add(self);
		};

		for (const [relPath, type] of (await list({ path, glob, json: true }, response, conv))) {
			if (type !== 'file') continue;
			if (matches >= maxResults) break;

			await enqueue(async () => {
				if (matches >= maxResults) return;

				let content;
				try {
					content = await read({ path: path + "/" + relPath, format: "raw", maxChars: 65536 }, response, conv);
				} catch {
					return;
				}

				if (matches >= maxResults) return;

				const lines = content.split("\n");
				let match;
				for (let i = 0; i < lines.length; i++) {
					if (regExp.test(lines[i])) {
						if (!match) {
							if (results) results += '\n';
							results += relPath+'\n';
							match = true;
						}

						let line = lines[i];
						if (line.length > MAX_LINE_LENGTH) line = "[Omitted long matching line]"; // 行为统一
						results += (i+1)+":"+line+'\n';
						if (++matches >= maxResults) return;
					}
				}
			})
		}

		await Promise.all(taskQueue);

		return results || '[No match]';
	},
};

/** @type {AiChat.FunctionTool} */
const RunBackgroundProgram = {
	name: "RunBackgroundProgram",
	description: "Execute a program in background.",
	interactive: "secure",
	script: fileAccess("run_bg"),

	parameters: {
		type: "object",
		properties: {
			explanation: { type: "string" },
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
				default: -1,
				description: "(in seconds)"
			}
		},
		required: ["explanation", "program", "arguments"]
	}
};
const StopBackgroundProgram = {
	name: "StopBackgroundProgram",
	description: "Stop a previous launched background program.",
	script: fileAccess("stop_bg"),

	parameters: {
		type: "object",
		properties: {
			programId: { type: "string", },
		},
		required: ["programId"]
	}
};

/** @type {AiChat.FunctionTool} */
const RunProgram = {
	name: "RunProgram",
	description: "Execute a program with an array of arguments.",
	interactive: "secure",
	script: fileAccess("spawn"),

	parameters: {
		type: "object",
		properties: {
			explanation: { type: "string" },
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
		required: ["explanation", "program", "arguments"]
	}
};
/** @type {AiChat.FunctionTool} */
const Shell = {
	name: "Shell",
	description: "Run a command string through a shell.",
	interactive: "secure",
	script: fileAccess("shell"),

	parameters: {
		type: "object",
		properties: {
			explanation: { type: "string" },
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
		required: ["explanation", "command"]
	}
};

let fsPrompt = `<file-editing>
- Root path is '.', **always** use relative path.
- All writing tools like Append and Write, will automatically create intermediate directories.
- Grep result is \`ripgrep --heading\` format:
\`\`\`
a.txt
5:content

b.txt
2:content
\`\`\`
</file-editing>`;
const fsTools = [Glob, Read, ReadImage, Grep, Stat, AskUser, Edit, Write, Append, Delete, Mkdirs, CopyMove];
if (config.fs_hashline) {
	Read.parameters.properties.format = {
		type: "string",
		enum: ["raw", "lineNumber", "anchors"]
	}
	Edit.description +=
		" Use this for simple, one-shot substitutions." +
		" For multi‑edit, insertions, deletions, or when you can't guarantee a unique match, use `patch` with anchors instead.";

	fsTools.push(Patch);
	fsPrompt += `<file-edit-guide>
For all file editing, use Read + Patch (anchor‑based) or Edit (string‑based).

### Reading files

Call \`Read\` with one of three formats:

- **\`raw\`** — plain text, no metadata. Use for quick inspection when you don't need line‑level precision.
- **\`lineNumber\`** — content prefixed with \`N\\t\`. Lightweight: use to scan structure, locate edits, or pair with \`replace\`'s \`start_line\`/\`end_line\`. Cheaper than \`anchors\` (no hash overhead).
- **\`anchors\`** — content prefixed with \`N#hash\\t\`. Required before \`patch\`. Hash anchors let \`patch\` survive line‑number shifts from earlier edits.

**Strategy**: explore with \`lineNumber\` first (lower token cost). Switch to \`anchors\` only when you're ready to call \`patch\`.

### Anchor‑based editing (preferred for multi‑edit, insertions, or large files)

1. **Read with anchors**: Use \`Read(format='anchors')\`. The response looks like:

\`\`\`
1#fdb1	content
...
1234#e7b7	test
[TRUNCATED: 1234 of 5678 lines shown]
\`\`\`

The anchor is \`1#fdb1\` and \`1234#e7b7\`.

Without \`anchors\` format, you cannot use \`patch\`.

2. **Patch**: Use \`Patch\` with arrays of:
   - \`startAnchor\`: first line to replace (inclusive).
   - \`endAnchor\`: last line to replace (inclusive).
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

### String‑based editing

Use \`Edit\` when you have an exact string to swap once.

To disambiguate when the search string appears multiple times, narrow the scope with:
- \`startLine\` / \`endLine\` (inclusive) — restrict the search to that line range.

Typical workflow: \`Read(format: "lineNumber")\` → spot the line number → \`Edit(search=..., replace=..., startLine=42, endLine=43)\`.

### Guidelines
- Use \`Read(format: "lineNumber")\` for exploration — cheaper than \`anchors\`.
- Use \`Patch\` for structural changes, multi‑line edits, insertions, or deletions.
- Use \`Edit\` only for single, unambiguous find‑and‑replace.
</file-edit-guide>`;
}

registerTools(
	"Files",
	"Read, write, search and delete files in the workspace.",
	fsTools,
	{ systemPrompt: fsPrompt }
);

registerTools(
	"FilesReadonly",
	"只读文件访问.",
	[Glob, Read, ReadImage, Grep, Stat, AskUser],
	{ systemPrompt: fsPrompt, hidden: "manual" }
);

let spawnPrompt;

function checkEnv(tools) {
	if (!config.fs_server) throw '请配置基于后端的文件访问服务';
	return tools;
}

registerTools(
	"Shell",
	"Run native programs / commands for package managers, builds, tests, scripts, and other command-line executions.",
	[RunProgram, Shell, RunBackgroundProgram, StopBackgroundProgram],
	{
		onActivated: checkEnv,
		async systemPrompt() {
			let shellInfo = '';

			if (!spawnPrompt) {
				checkEnv();

				let {prompt} = await apiFileSystem("env");
				if (prompt.startsWith("os: Windows")) {
					if (!prompt.includes("bash: No")) {
						shellInfo = "emulated bash";
					} else {
						shellInfo = "powershell\n   - Powershell have many escape and encoding issues. Use script file if available."
					}
				} else {
					shellInfo = 'bash';
				}
				spawnPrompt = `<system-environment>
Environment and runtimes:
${prompt}
</system-environment>
<command-execution>
### Running commands in the sandbox

- **RunProgram**: Execute a program with an array of arguments.
   - Escaping-safe (no shell interpretation), ideal for complex arguments.
   - Examples: package managers (npm, pip, cargo), compilers, interpreters (python, node, java), tests, builds.

- **Shell**: Run a command string through a shell.
   - Use when you need pipelines (\`|\`), redirections (\`>\`, \`<\`, \`2>&1\`), chaining (\`&&\`, \`||\`), or shell syntax.
   - Shell: ${shellInfo}

- *RunBackgroundProgram*: Execute a background (non-blocking) program.
   - Run a program and don't wait for it to end.
   - Returns:
      - \`programId\` for \`StopBackgroundProgram\`.
      - \`logPath\` for \`Read\` (Use offset=-N to read last N lines).
   - Examples: dev server (\`npm run dev\`) and long time tasks.

### Guidelines
- Prefer a reusable script file (Python, JS, shell, etc.) over repeating near-same commands.
- Use \`RunProgram\` when you don't need shell features (safer, no escaping pitfalls).
- Use \`Shell\` only when you must: pipelines, redirections, chaining, or shell built-ins.
- \`explanation\` parameter:
   - REQUIRED for every command.
   - One sentence human-readable summary of why run it.
   - Logged for audit purposes.
- Always use relative path.
- Large output will be redirected to log files.
</command-execution>`;
			}
			return spawnPrompt;
		}
	}
);