import {getToolParameters, prefixTitle, registerToolset} from "/src/toolset.js";
import {EVENT_BUS, inputText, messages, selectedConversation, updateMessageUI} from "/src/states.js";
import {$state, $update, $watch, debugSymbol, unconscious} from "unconscious";
import {AskUser} from "../rp_kit/AskUser.js";
import {callFileSystemFunc, createFileSystem, fileAccess, FS_INSTANCE, getFileSystem,} from "./Mounts.js";
import {RunJS, SearchModules} from "./run_js.js";
import {readAsString} from "/common/chardet.js";
import {downloadFile, errorBlock} from "/src/utils/utils.js";
import {ZipWriter} from "unconscious/common/zip-io.js";
import {InspectImage} from "./inspect_image.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {prettyTime} from "unconscious/common/Utils.js";
import {DiffHeader, HighlightBox, makeDiff, TextDiff} from "/src/components/TextDiff.jsx";
import {createAsyncQueue} from "/common/pure-utils.js";
import {getCombinedPreset, markMessageDirty} from "/src/database.js";
import {compileGrepPattern} from "/common/fs-common.js";
import "./GrepCard.css";
import {normalizePath} from "unconscious/common/path-utils.js";
import {getChangeableFiles} from "./overwrite-monitor.js";
import {showToast} from "/src/components/Toast.js";
import {shellPrompt, shellTools} from "./RemoteFSShell.js";
import {vcsEnabledKey, vcsTools} from "./VCS.js";

const DIFF_CACHE = debugSymbol("Diff");
/**
 *
 * @param {string} prefix
 * @param {function(Record<string, string>): import("unconscious/common/text-diff.d.ts").DiffOp[]} fn
 * @return {function(OpenAI.ToolCall, AiChat.ToolResponse): JSX.Element}
 */
const diffTitleRenderer = (prefix, fn) => (req, ctx) => {
	const par = getToolParameters(ctx, req);
	let diff = ctx[DIFF_CACHE];
	if (undefined === diff) diff = ctx[DIFF_CACHE] = fn(par);
	const str = prefix+" "+par.path;
	return null === diff ? str : <>{str}<span className={"spacer"} /><DiffHeader diff={diff} /></>
};
/**
 *
 * @param {function(Record<string, string>): import("unconscious/common/text-diff.d.ts").DiffOp[]} fn
 * @return {function(AiChat.ToolResponse, HTMLElement, OpenAI.ToolCall): JSX.Element}
 */
const diffContentRenderer = (fn) => (ctx, box, tc) => {
	if (ctx.success !== true || !ctx.content) return false;

	const par = getToolParameters(ctx, tc);
	let diff = ctx[DIFF_CACHE];
	if (undefined === diff) diff = ctx[DIFF_CACHE] = fn(par);

	const searchString = "changedRange: ";
	const starts = ctx.content.split("\n").filter(l => l.startsWith(searchString)).map(l => parseInt(l.slice(searchString.length)));

	return null === diff ? false : <TextDiff start={starts} diff={diff} filename={par.path} />
};

let globFiles, readFile = fileAccess("read"), writeFile = fileAccess("write"), statFile;
//region Filesystem tools
/** @type {AiChat.FunctionTool} */
const Glob = {
	name: "Glob",
	description: "Execute glob pattern in \`path\`.\nReturn TSV rows [relative path\ttype (dir or file)\tsize]",
	parallel: true,
	script: globFiles = fileAccess('list'),
	title(req, ctx ) {
		const {path = '.', pattern = '*'} = getToolParameters(ctx, req);
		return pattern !== "*"
			? "列出 " + path + "/" + pattern
			: "列出 " + path;
	},

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", default: '.' },
			pattern: { type: "string", default: "*" },
			limit: { type: "integer", default: 200, minimum: 1, maximum: 1000 },
			modifiedSince: { type: "string", description: "ISO-8601 timestamp filter" },
			//depth: { type: "integer", description: "Optional maximum directory tree depth" },
		}
	}
};

/** @type {AiChat.FunctionTool} */
const Read = {
	name: "Read",
	description: "Read a file by 1-based line `offset`." +
		" Negative `offset` count from the end." +
		" Return at most `limit` lines." +
		"\nErrors are separated from content by delimiter '\x03'; everything after '\x03' is error details, not file content." +
		"\nExamples:\n" +
		"\n - Read(offset=-5) for a 10-line file return line 6-10" +
		"\n - Read(offset=-5, limit=3) for that file return line 6-8",
	parallel: true,
	async script(par, resp, conv) {
		if (par.path.match(/\.(png|jpg|jpeg|bmp|webp)$/i)) {
			const hasImageCapability = (await getCombinedPreset(conv)).modalities.includes("image");
			if (hasImageCapability) return InspectImage.script(par, resp, conv);
		}

		const content = await readFile(par, resp, conv);
		await getChangeableFiles(conv, par.path);
		return content;
	},
	title: prefixTitle("读取"),
	renderOutput(ctx, box, toolIsRunning, tc) {
		let content = ctx.success && ctx.content;
		if (!content) return false;

		let {path, format, offset = 1} = getToolParameters(ctx, tc);

		let error;
		const errorPos = content.lastIndexOf('\x03');
		if (errorPos > 0) {
			error = content.slice(errorPos+1).trim();
			content = content.slice(0, errorPos);
		}

		if (format === 'lineNumber') {
			const off = Number(content.slice(0, content.indexOf('\x1F')));
			if (isFinite(off)) offset = off;
			content = content.split('\n').map(s => s.slice(s.indexOf('\x1F')+1)).join('\n');
		}

		const highlight = <HighlightBox start={offset} code={content} filename={path} />;

		if (error) {
			return <div>
				{errorBlock(error, "注意")}
				{highlight}
			</div>
		}

		return highlight;
	},

	fix(par) {
		if (!par.format) {
			par.format = "raw";
		}
	},

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			format: {
				type: "string",
				enum: ["raw", "lineNumber"]
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

const writeDiffHandler = (args) => {
	const content = args.content;
	return content && makeDiff('', content);
};

/** @type {AiChat.FunctionTool} */
const Write = {
	name: "Write",
	description: "Write a file.",
	parallel: true,
	async script(par, ctx, conv) {
		let changeable = await getChangeableFiles(conv);
		if (changeable.has(par.path)) par = { ...par, overwrite: true };
		const result = await writeFile(par, ctx, conv);
		changeable.add(par.path);
		return result;
	},
	title: (req, ctx) => {
		const par = getToolParameters(ctx, req);
		let diff = ctx[DIFF_CACHE];
		if (undefined === diff) diff = ctx[DIFF_CACHE] = par.content.split('\n').length;
		const str = "写入 " + par.path;
		return <>
			{str}
			<span className={"spacer"}/>
			<span style={"color:var(--ok)"}>+{diff}</span>
		</>
	},
	renderInput: (ctx, box, tc, message) => {
		const par = getToolParameters(ctx, tc);

		box.previousElementSibling.append(<button className={"danger"} onClick={async () => {
			const start = Date.now();
			par.content = await readFile({
				path: par.path,
				noTruncate: true
			}, ctx, unconscious(selectedConversation));
			tc.function.arguments = JSON.stringify(par);

			const now = Date.now();
			ctx.time = now;
			ctx.duration = now - start;
			delete ctx[DIFF_CACHE];

			// 其实只要更新TextDiff和DiffHeader两个组件
			const tcs = message.tool_calls;
			const idx = tcs.indexOf(tc);
			tcs[idx] = {...tc};
			$update(updateMessageUI);

			markMessageDirty(message);
		}}>回读<span className={"tooltip"}>{"从磁盘读取文件，更新工具数据\n（反向操作）\n仅限专业人士操作！"}</span>
		</button>);

		return <HighlightBox start={1} code={par.content} filename={par.path}/>
	},

	parameters: {
		type: "object",
		properties: {
			path: {type: "string",},
			content: {type: "string"}
		},
		required: ["path", "content"]
	}
};

/** @type {AiChat.FunctionTool} */
const Append = {
	name: "Append",
	description: "Append to the end of a file. New file will be created.",
	script: fileAccess("append"),
	title: diffTitleRenderer("追加", writeDiffHandler),
	renderInput: diffContentRenderer(writeDiffHandler),
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
			content: { type: "string" },
			newline: {
				type: "boolean",
				default: true,
				description: "If true and the file doesn't end with a LF ('\n'), one is inserted before content."
			},
		},
		required: ["path", "content"]
	}
};

// ============ 解析器：Unified Diff Hunk → search/replace ============
function parseUnifiedHunk(text) {
	const lines = String(text == null ? "" : text).split("\n");
	const hunks = [];
	let cur = null;
	const close = () => {
		if (cur && (cur.old.length || cur.new.length)) hunks.push(cur);
		cur = null;
	};

	for (const raw of lines) {
		if (/^@@/.test(raw)) {                 // hunk 表头：行号只是提示，不校验
			close();
			cur = { old: [], new: [] };
			continue;
		}
		if (raw.startsWith("\\")) continue;    // “\ No newline at end of file”
		if (/^---\s/.test(raw) || /^\+\+\+\s/.test(raw)) continue; // 补丁文件头，忽略

		if (cur == null) {
			if (/^[ +-]/.test(raw)) cur = { old: [], new: [] };
			else continue;
		}

		const body = raw.length > 0 ? raw.slice(1) : "";
		if (raw.startsWith(" "))      { cur.old.push(body); cur.new.push(body); }        // 锚点：两边共有
		else if (raw.startsWith("-")) { cur.old.push(body); }                            // 删除
		else if (raw.startsWith("+")) { cur.new.push(body); }                            // 插入
		else { close(); }                                                               // 非法行，结束 hunk
	}
	close();
	return hunks.map(h => ({ search: h.old.join("\n"), replace: h.new.join("\n") }));
}

const patchHandler = fileAccess("patch");
const patchDiffHandler = (par) => {
	const diff = [];
	parseUnifiedHunk(par.diff)
		.filter(i => i.search !== i.replace)
		.forEach(({search, replace}) => {
			diff.push({ type: "hunk", text: par.path })
			diff.push(...makeDiff(search, replace));
		});
	return diff;
};

/** @type {AiChat.FunctionTool} */
const Patch = {
	name: "Patch",
	description: "Apply unified diff hunks atomically to a file. (`@@` numbers are ignored).",
	title: diffTitleRenderer("修改", patchDiffHandler),
	renderInput: diffContentRenderer(patchDiffHandler),
	script(par, ctx, conv) {
		const changes = parseUnifiedHunk(par.diff);
		if (!changes.length) throw ("Patch contains no valid hunks");

		return patchHandler({
			path: par.path,
			changes
		}, ctx, conv);
	},
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			diff: { type: "string" },
		},
		required: ["path", "diff"]
	}
};

const editDiffHandler = ({search, replace}) => {
	if (search != null && replace != null && search !== replace) {
		return makeDiff(search, replace);
	}
}

/** @type {AiChat.FunctionTool} */
const Edit = {
	name: "Edit",
	description:
		"Atomically find and replace text within a file." +
		" Use optional 1-based inclusive `startLine` and `endLine` to narrow the range (search/replace scope)." +
		" When `replaceAll` is true, replaces all occurrences in that range." +
		" When `replaceAll` is false, it must occur exactly once in that range.",
	script: fileAccess("edit"),
	title: diffTitleRenderer("修改", editDiffHandler),
	renderInput: diffContentRenderer(editDiffHandler),

	fix(par) {
		const keys = Object.keys(par);
		if (!par.search) {
			const res = keys.filter(key => key.includes("old"));
			if (res.length === 1) {
				par.search = par[res[0]];
				delete par[res[0]];
			}
		}
		if (!par.replace) {
			const res = keys.filter(key => key.includes("new"));
			if (res.length === 1) {
				par.replace = par[res[0]];
				delete par[res[0]];
			}
		}
	},

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
const Mkdir = {
	name: "Mkdir",
	description: "Create directory recursively",
	parallel: true,
	script: fileAccess("mkdir"),
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
	async script({src, dest, move}, ctx, conv) {
		if (conv.fs_readonly) throw "Write-protect is enabled";
		if (src === dest) throw 'src and dest are same';

		let srcFileSystem, destFileSystem;
		[src, srcFileSystem] = await getFileSystem(src, conv);
		[dest, destFileSystem] = await getFileSystem(dest, conv);

		if (srcFileSystem === destFileSystem) {
			if (normalizePath(dest).join('/').startsWith(normalizePath(src).join('/')+"/"))
				throw "Cannot move into descents";

			return callFileSystemFunc(srcFileSystem, 'copy', {
				src,
				dest,
				move
			}, conv);
		}

		const fileType = await callFileSystemFunc(srcFileSystem, 'stat', { path: src });
		if (fileType.startsWith('type: file')) {
			const content = await callFileSystemFunc(srcFileSystem, 'readRaw', { path: src });
			await callFileSystemFunc(destFileSystem, 'writeRaw', { path: dest, content });
		} else {
			const srcFiles = await callFileSystemFunc(srcFileSystem, 'list', {
				path: src,
				pattern: '**',
				json: true,
				showDir: false
			}, conv);

			const [enqueue, waitAll] = createAsyncQueue();

			for (const [path] of srcFiles) {
				await enqueue(async() => {
					const content = await callFileSystemFunc(srcFileSystem, 'readRaw', {path});
					await callFileSystemFunc(destFileSystem, 'writeRaw', { path, content });
				});
			}

			await waitAll();
		}

		if (move) {
			await callFileSystemFunc(srcFileSystem, 'delete', { path: src });
		}

		return 'Success';
	},
	title(req, ctx) {
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
	parallel: "same",
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
	parallel: true,
	script: statFile = fileAccess("stat"),
	title: prefixTitle("读元数据"),

	parameters: {
		type: "object",
		properties: {
			path: { type: "string", },
		},
		required: ["path"]
	}
};

/** @type {AiChat.FunctionTool} */
const Grep = {
	name: "Grep",
	description: `Search for a regex pattern across files.\nResult example:
\`\`\`
a.txt
5\x1Fcontent

b.txt
2\x1Fcontent
\`\`\``,
	parallel: true,
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "JS regular expression pattern with optional flags", example: "(?iu)System" },
			path: { type: "string", default: ".", description: "Directory or file" },
			glob: { type: "string", default: "**" },
			context: { type: "number", default: 0, description: "Show lines before and after each match." },
			maxFiles: { type: "integer", default: 50, minimum: 1, maximum: 500 },
			maxMatchesPerFile: { type: "integer", default: 10, minimum: 1, maximum: 100 },
		},
		required: ["pattern"],
	},

	title(req, ctx) {
		const {pattern, path = '.', glob = '**'} = getToolParameters(ctx, req);
		const p = pattern.length > 30 ? pattern.slice(0, 30) + "…" : pattern;
		return "搜索 " + (glob !== "**" ? path + "/" + glob : path) + " 中的 " + p;
	},
	script: fileAccess('grep'),

	renderOutput(ctx, box, running, tc) {
		let content = ctx.success && ctx.content;
		if (!content) return false;

		const {path = '', pattern} = getToolParameters(ctx, tc);
		const regexp = compileGrepPattern(pattern);

		let matchCount = 0;

		const chunks = content.trim().split("\n\n");
		const parseMatches = l => {
			if (l === '---') return { type: 'hunk', text: "---" };

			// 兼容 \x1F 或常见冒号分隔
			let splitIdx = l.indexOf('\x1f');
			if (splitIdx === -1) splitIdx = l.indexOf('-');
			else matchCount++;
			return {
				line: l.substring(0, splitIdx).trim(),
				text: l.substring(splitIdx + 1)
			};
		};

		const files = chunks.length > 1 || isNaN(parseInt(chunks[0][0])) ? chunks.map(chunk => {
			const lines = chunk.split('\n');
			const path = lines[0].trim();
			let prevMatches = matchCount;
			const matches = lines.slice(1).map(parseMatches);
			return { path, matches, matchCount: matchCount - prevMatches };
		}) : [{
			path: '',
			matches: chunks[0].split('\n').map(parseMatches)
		}];

		function escapeAndHighlight(str) {
			const div = <div>{str}</div>;
			return div.innerHTML.replace(regexp, '<mark>$&</mark>');
		}

		if (!matchCount) return false;

		return <div className={"grep-card"}>
			{files.map(file => {
				return <details open>
					<summary>
						<span className="chevron ri-play-large-fill" />
						<span className="path">{(path === '.' ? '' : path + '/') + file.path}</span>
						<span className="spacer"/>
						<span className="match-badge">{file.matchCount} 匹配</span>
					</summary>
					<pre className={"textDiff"} style={"--lw:7ch"}>
						{file.matches.map(match => {
							return match.type === 'hunk' ? <div className={"line hunk"}>{match.text}</div> :
								<div className={"line"}>
									<span className={"no"}>{match.line + " "}</span>
									<span className={"text"} dangerouslySetInnerHTML={escapeAndHighlight(match.text)}/>
								</div>
						})}
					</pre>
				</details>
			})}
		</div>
	}
};
//endregion
//region Filesystem management tools
/**
 * @type {AiChat.FunctionTool}
 */
const Mount = {
	name: "Mount",
	description: "Mount a new VFS, new workspace, new project, and even a new computer.",
	parameters: {
		type: "object",
		properties: {
			subdir: {
				type: "string",
				description: "pathname hint"
			},
			label: {
				type: "string",
				description: "Short human-readable instruction telling the user which folder to provide.",
			},
		},
		required: ["subdir", "label"],
	},
	title: prefixTitle("挂载", 'subdir'),

	async script({subdir, label}, resp, conv) {
		if (/[~/]/.test(subdir)) throw 'path contains invalid character';

		const opt = {fs_label: label};
		await createFileSystem(opt);

		const fsBase = opt.fs_base;
		if (fsBase && !fsBase.includes("/")) subdir = fsBase;

		resp.subdir = subdir;
		(conv.mnt || (conv.mnt = {}))[subdir] = opt;
		return "New VFS mounted on ~/" + (subdir);
	},
	undo(resp, conv, tc) {
		const mnt = conv.mnt;
		if (mnt) delete mnt[resp.subdir || getToolParameters(resp, tc).subdir];
	},

	renderer(context, frozen, tc) {
		const data = getToolParameters(context, tc);
		const subdir = $state(context.subdir || data.subdir);
		const conv = unconscious(selectedConversation);
		const isRevoked = $state(!conv.mnt?.[subdir]);

		return (
			<div className={`skills`} class:revoked={isRevoked}>
				<div className="tool-label-group">
					<span>⚡ 挂载:</span>
					<input className="tool-tag" value={subdir} disabled={frozen}/>
				</div>

				<span style={{flex: 1}}></span>

				{() => unconscious(isRevoked) ? (
					<div className="revoked-status tool-label-group">
						<svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
								  d="M6 18L18 6M6 6l12 12"/>
						</svg>
						已撤销
					</div>
				) : (
					<button className="revoke-btn" onClick={() => {
						isRevoked.value = true;
						this.undo(context, selectedConversation);
						$update(messages);
					}}>
						撤销
					</button>
				)}
			</div>
		);
	},
};

/**
 * @type {AiChat.FunctionTool}
 */
const Mounts = {
	name: "Mounts",
	description: "List all mounted VFSs" +
		"Return: `\"<mount-point>\" (type=<type>, remote_path=<base>, label=<label>)`.\n" +
		"Non-root mount points are accessed via `~/<mount-point>/`.",
	title: () => "列出文件系统",

	script(_, resp, conv) {
		const arr = Object.entries(conv.mnt||{});
		arr.unshift([".", conv]);
		return "Total "+(arr.length)+"\n"+arr.map(([k, {fs_type, fs_base, fs_name}], i) => JSON.stringify(i ? "~/"+k : k)+" (type="+fs_type+", remote_path="+JSON.stringify(fs_base||"/")+", label="+JSON.stringify(fs_name||"")+")").join("\n");
	},
};
//endregion
const fileSystemTools = [Glob, Read, Grep, Stat, AskUser, Edit, Patch, Write, Append, Delete, Mkdir, CopyMove, Mount, Mounts];
const imageReadTools = [InspectImage];
const filesystemPrompt = `<file-editing>
- NEVER use absolute paths like \`/tmp\`, **ALWAYS** use relative path.
- All writing tools like Append and Write, will automatically create parent directories.
- DO NOT read file to verify edits, tool will return error details if edit failed.
- If a path is URI encoded, keep it, don't decode.
- Line-numbered output from any tool follows the format \`lineNumber\x1Fcontent\`
- Use Markdown hyperlink to reference existing files \`[Report](path/to/file)\`
</file-editing>`;

const shellFallbackTools = [RunJS, SearchModules];

//region VFS tools
const binaryWrite = fileAccess('writeRaw');
const binaryRead = fileAccess("readRaw");

/**
 * 请求用户提供文件内容。用户可直接输入或上传。
 * @type {AiChat.FunctionTool}
 */
const RequestFile = {
	name: "RequestFile",
	description: "Ask the user to upload file to \`path\`. Example: config, prose, data, image.",
	parameters: {
		type: "object",
		properties: {
			path: {type: "string",},
			type: {
				enum: ["text", "binary"]
			},
			label: {
				type: "string",
				description: "Short human-readable instruction telling the user what content to provide and why.",
			},
		},
		required: ["path", "type", "label"],
	},
	title: prefixTitle("上传"),

	interactive: true,
	script() {},

	keyFunc(keys, response, frozen) {
		keys.push(frozen);

		const obj = response.fc;
		if (obj) {
			delete response.fc;
			binaryWrite(obj, response, unconscious(selectedConversation));
		}
	},

	renderer(response, frozen, tc, message) {
		if (frozen) return;

		const data = getToolParameters(response, tc);
		const content = $state("");

		$watch(content, () => {
			response.success = true;
			response.content = unconscious(content) ? "File saved to "+data.path : null;
			response.fc = {
				path: data.path,
				content: unconscious(content)
			};
			markMessageDirty(message);
			$update(inputText);
		}, false);

		if (data.type === 'binary') {
			return (<div>
				<div style="font-weight:600;margin-bottom:8px;">✦ {data.label}</div>
				上传文件
				<input type={"file"} onChange={async (e) => {
					content.value = e.target.files[0];
				}}/>
			</div>);
		}

		let ta;
		return (<div>
			<div style="font-weight:600;margin-bottom:8px;">✦ {data.label}</div>

			<textarea
				ref={ta}
				rows={8}
				placeholder="在此输入内容…"
				className={"text-input"}
				style={`height:auto`}
				onInput={() => (content.value = ta.value)}
				value={content}
			/>

			或上传文件
			<input type={"file"} accept={"text/*"} onChange={async (e) => {
			const file = e.target.files[0];
			content.value = await readAsString(file)
		}}/>
		</div>);
	},
};

/**
 * 将工作区中的文件或文件夹提供给用户下载（文件夹自动打包为 Zip）。
 * @type {AiChat.FunctionTool}
 */
const SendFile = {
	name: "SendFile",
	description: "Provide a workspace file or folder for the user to download. Folders are automatically zipped. Call when the user asks to retrieve files (artifact).",
	parameters: {
		type: "object",
		properties: {
			path: {type: "string",},
		},
		required: ["path"],
	},
	title: (tc, response = {}) => {
		const path = getToolParameters(response, tc).path;
		const fileName = path.split("/").pop();

		const handleDownload = async () => {
			const conv = unconscious(selectedConversation);
			let blob;

			try {
				blob = await binaryRead({ path }, response, conv);
				blob = new File([blob], fileName, { type: blob.type });
			} catch {
				const files = await Glob.script({ path, pattern: "**", json: true }, response, conv);
				const zw = ZipWriter();

				for (const [relPath] of files) {
					const fullPath = path + "/" + relPath;
					const result = await binaryRead({ path: fullPath }, response, conv);
					await zw.add(relPath, result, { compression: true });
				}

				blob = zw.finish();
				blob.name = fileName + ".zip";
			}

			downloadFile(blob);
		};

		return <>
			展示 {path}
			<button
				onClick={handleDownload}
				className={"btn primary"}
				style={"margin-left:8px"}
			>下载</button>
		</>;
	},

	async script(opt, ctx, conv) {
		await statFile(opt, ctx, conv);
		return "Presented to user. Download not guaranteed. Confirm before deleting.";},
};
//endregion
const vfsTools = [RequestFile, SendFile];

// 隐藏工具集，仅用于注册所有动态加载的工具
registerToolset(
	"Files/Dynamic",
	"",
	[...shellTools, ...vfsTools, ...shellFallbackTools, ...imageReadTools],
	{
	hidden: true
});

const VCS_SUPPORT = debugSymbol("SupportVCS");
const FILESYSTEM_AUX_PROMPT = debugSymbol("ShellAvailabilityKnown");

/**
 * @param {AiChat.Conversation} conv
 */
const resetFileSystemSettings = conv => {
	delete conv.fs_base;
	delete conv.fs_type;
	delete conv.fs_server;
	delete conv[FS_INSTANCE];
	delete conv[FILESYSTEM_AUX_PROMPT];
};


registerToolset(
	"Files",
	"Operate files in the workspace and code execution.",
	fileSystemTools,
	{
		default: true,
		async systemPrompt(conv) {
			let fsType = conv.fs_type;
			const tools = conv.tools;
			const activatedModules = conv.activatedModules;
			const addTools = tool => tools.add(tool.name);
			const removeTools = tool => tools.delete(tool.name);

			if (null == fsType) {
				await createFileSystem(conv);
				fsType = conv.fs_type;
			}

			const isVirtualFileSystem = fsType === 'opfs' || fsType === 'config' || fsType === 'db';

			let auxPrompt = conv[FILESYSTEM_AUX_PROMPT];
			if (null == auxPrompt) {
				auxPrompt = '';
				if (fsType === 'api') auxPrompt += await shellPrompt(conv);
				conv[FILESYSTEM_AUX_PROMPT] = auxPrompt;
			}

			imageReadTools.forEach((await getCombinedPreset(conv)).modalities.includes('image') ? addTools : removeTools);

			let vcsSupported = conv[VCS_SUPPORT];
			const vcsEnabled = activatedModules.has(vcsEnabledKey);
			if (vcsEnabled && vcsSupported == null) {
				vcsSupported = false;
				try {
					const fs = await createFileSystem(conv);
					await callFileSystemFunc(fs, 'vcs', {}, conv);
					vcsSupported = true;
				} catch {}
				conv[VCS_SUPPORT] = !!vcsSupported;
			}
			const useVCS = vcsEnabled && vcsSupported;
			vcsTools.forEach(useVCS ? addTools : removeTools);

			const hasShell = fsType === 'api' && auxPrompt;
			if (hasShell) {
				shellTools.forEach(addTools);
				shellFallbackTools.forEach(removeTools);
			} else {
				shellTools.forEach(removeTools);
				shellFallbackTools.forEach(addTools);
			}

			if (activatedModules.has("InteractiveSimulation")) {
				tools.add(RunJS.name);
			}

			vfsTools.forEach(isVirtualFileSystem || activatedModules.has("FileTransfer") ? addTools : removeTools);

			return filesystemPrompt + auxPrompt;
		},
		onDeactivated: resetFileSystemSettings
	}
);
registerToolset(
	"Files/Readonly",
	"文件系统只读.",
	[],
	{
		hidden: "manual",
		onActivated(conv) {
			conv.fs_readonly = true;
		},
		onDeactivated(conv) {
			conv.fs_readonly = false;
		}
	}
);
registerToolset(
	"FileTransfer",
	"Interactive user-AI file exchange: upload & download.",
	[RequestFile, SendFile],
	{
		hidden: 'manual',
		depend: ["Files"]
	}
);

COMMAND_REGISTRY['fsync'] = [
	async (arg) => {
		const conv = unconscious(selectedConversation);
		const lastTime = messages.at(-1).time;
		if (null == lastTime) return;

		const list = fileAccess('list');
		const readFiles = new Map;
		messages.forEach(m => {
			const tr = m.tool_responses;
			const tc = m.tool_calls;
			if (tr) for (let i = 0; i < tr.length; i++) {
				const fn = tc[i].function.name;
				if (fn === "Read" || fn === "Edit" || fn === "Write" || fn === "Append" || fn === "Patch" || fn === "Stat") {
					const arg = getToolParameters(tr[i], tc[i], true);
					readFiles.set(normalizePath(arg.path).join('/'), 1);
				}
			}
		});

		const result = (await list({
			pattern: '**',
			json: true,
			modifiedSince: lastTime
		}, {}, conv)).filter(item => readFiles.has(item[0]));
		if (!result.length) return;

		messages.push({
			role: 'user',
			time: Date.now(),
			content: '<system-remainder>\nThese files were changed:\n```\n'+result.map(([name, type, size, time]) => {
				return name+'\t'+prettyTime(time);
			}).join('\n')+'\n```\n</system-remainder>',
			label: "文件系统变更"
		});
	},
	"通知AI文件系统变更",
];

COMMAND_REGISTRY["fsreset"] = [
	(args) => {
		const conv = unconscious(selectedConversation);
		if (!conv) return;
		resetFileSystemSettings(conv);
		showToast("下一次文件操作将要求重新选择");
	},
	"重置文件系统选择"
];

EVENT_BUS.on('resolveUrl', (path) => {
	const conv = unconscious(selectedConversation);
	return binaryRead( { path }, {}, conv).then(blob => blob.toUrl());
});