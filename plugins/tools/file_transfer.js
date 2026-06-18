import {getToolParameters, registerTools} from "/src/skills.js";
import {fileAccess, prefixTitle} from "./agent.js";
import {$state, $update, $watch, unconscious} from "unconscious";
import {inputText, selectedConversation} from "/src/states.js";
import {readAsString} from "/common/chardet.js";
import {ZipWriter} from "unconscious/common/zip-io.js";
import {downloadFile} from "/src/utils/utils.js";

const systemPrompt = `<file-interaction-policy>
### You have two file-interaction tools

- **RequestFile**: Let user provide text file (config, prose, data).
- **SendFile**: Let user download a file or folder from the workspace. Folders are auto-zipped.

### Anti-patterns

- Do NOT call RequestFile when you can generate the content yourself — only when user input is genuinely required.
- Do NOT embed (repeat) large file contents in chat — use SendFile for downloads.
</file-interaction-policy>`;

const listDir = fileAccess("list");
const readFile = fileAccess("read");
const writeFile = fileAccess("write");

/**
 * AI 请求用户提供文件内容。用户可在文本区直接输入，或从预设选项中选择。
 * @type {AiChat.FunctionTool}
 */
const RequestFile = {
	name: "RequestFile",
	description: "Ask the user to upload (text) file to \`path\`.",
	parameters: {
		type: "object",
		properties: {
			path: {type: "string",},
			label: {
				type: "string",
				description: "Short human-readable instruction telling the user what content to provide and why.",
			},
		},
		required: ["path", "label"],
	},
	title: prefixTitle("上传"),

	interactive: true,
	script() {},

	keyFunc(keys, response, frozen) {
		keys.push(frozen);

		const obj = response.dirty;
		if (obj) {
			delete response.dirty;
			writeFile(obj, response, unconscious(selectedConversation));
		}
	},

	renderer(response, frozen, tc) {
		const data = getToolParameters(response, tc);
		const content = $state("");

		$watch(content, () => {
			response.success = true;
			response.content = unconscious(content) ? "File saved to "+data.path : null;
			response.dirty = {
				path: data.path,
				content: unconscious(content)
			};
			$update(inputText);
		}, false);

		if (frozen) return;

		let ta;
		return (
			<div>
				<div style="font-weight:600;margin-bottom:8px;">
					✦ {data.label}
				</div>

				<textarea
					ref={ta}
					rows={8}
					placeholder="在此输入内容…"
					className={"text-input"}
					style={`height:auto`}
					onInput={() => (content.value = ta.value)}
					value={content}
				/>

				或上传文件<input type={"file"} accept={"text/*"} onChange={async (e) => {
					const file = e.target.files[0];
					content.value = await readAsString(file)
			}}/>
			</div>
		);
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
				const result = await readFile({ path, format: "raw" }, response, conv);
				blob = new File([result], fileName, { type: "text/plain" });
			} catch {
				const files = await listDir({ path, glob: "**", json: true }, response, conv);
				const zw = ZipWriter();

				for (const [relPath] of files) {
					const fullPath = path + "/" + relPath;
					const result = await readFile({ path: fullPath, format: "raw" }, response, conv);
					await zw.add(relPath, result, { compress: true });
				}

				blob = zw.finish();
				blob.name = fileName + ".zip";
			}

			downloadFile(blob);
		};

		return <>
			展示构件
			<button
				onClick={handleDownload}
				className={"btn primary"}
				style={"margin-left:8px"}
			>下载 {path}</button>
		</>;
	},

	script() {return "Presented to user. Download not guaranteed. Confirm before deleting.";},
};

export const registerFileTransfer = () => (
	registerTools(
		"FileTransfer",
		"Interactive user-AI file exchange, upload & download tools. (depends on 'Files')",
		[RequestFile, SendFile],
		{ systemPrompt }
	)
);
