import {getToolParameters, registerToolset} from "/src/toolset.js";
import {fileAccess} from "./fileAccess.js";
import {prefixTitle} from "./agent.js";
import {compileSchema, jsonEval, parseJsonPointer, validate} from "unconscious/common/json-schema-utils.js";
import {parseJson5} from "unconscious/common/Json.js";

const systemPrompt = `<json-edit-policy>
### RFC 6901 + extensions

- Use \`~0\` and \`~1\` to escape.
- Trailing \`-\` means append-to-array.

### Rules of thumb

- Rewriting most of the file → **WriteJson**, otherwise **EditJson**.
- Never use \`/-\` on a non-array.
- After structural edits, run ValidateJson before considering the task done.
</json-edit-policy>`;

const readFile = fileAccess("read");
const writeFile = fileAccess("write");

/**
 * @type {AiChat.FunctionTool}
 */
const EditJson = {
	name: "EditJson",
	description: `Partially update a JSON file by targeting a specific node via RFC 6901 JSON Pointer.

Modes:
- **set** (default): Provide \`value\` + pointer to key/index. Missing intermediates are initialized to \`{}\`, explicitly create empty array before push if not exist.
- **push**: Pointer ends with \`/-\` to append \`value\` to the array.
- **delete**: Omit \`value\` to remove the node. Array elements are spliced (e.g. \`/items/1\` → splice index 1).`,
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			pointer: { type: "string", },
			value: { type: "value", },
		},
		required: ["path", "pointer"]
	},

	async script({path, pointer, value}, response, global) {
		const text = await readFile({
			path,
			noTruncate: true
		}, response, global);

		let obj;
		try {
			obj = parseJson5(text);
		} catch (e) {
			throw "file cannot be parsed:\n"+e;
		}

		const jsonPointer = parseJsonPointer(pointer);
		let action = value === undefined ? "delete" : "set";
		if (jsonPointer.at(-1) === '-') {
			action = "push";
			jsonPointer.pop();
		}

		const undo = jsonEval(obj, jsonPointer, action, value).undo;
		response.undo = undo;

		await writeFile({
			path,
			content: JSON.stringify(obj, null, 2)
		}, response, global);

		return "Success. undoHandle="+JSON.stringify(undo);
	},
	title: prefixTitle("编辑JSON")
};

/**
 * @type {AiChat.FunctionTool}
 */
const WriteJson = {
	name: "WriteJson",
	description: "Write a JSON file, serializing the content with 2-space indentation.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			content: { description: "Complete JSON object or array that replaces all existing content.", type: ["object", "array"], },
			overwrite: { type: "boolean", default: false }
		},
		required: ["path", "content"]
	},

	script({path, content, overwrite}, response, global) {
		return writeFile({path, content: JSON.stringify(content, null, 2), overwrite}, response, global);
	},
	title: prefixTitle("写入JSON")
}

/**
 * @type {AiChat.FunctionTool}
 */
const ValidateJson = {
	name: "ValidateJson",
	description: `Validate a JSON file (data) based on the JSON schema file - after edits, before commits, or debugging.
Returns "valid" on success, or error messages with node path on failure.`,
	parameters: {
		type: "object",
		properties: {
			schemaPath: { type: "string" },
			dataPath: { type: "string" },
		},
		required: ["schemaPath", "dataPath"]
	},

	async script({schemaPath, dataPath}, response, global) {
		let schema, data;

		try {
			data = parseJson5(await readFile({
				path: dataPath,
				noTruncate: true
			}, response, global));
		} catch (e) {
			return "data cannot be parsed:\n"+(e.message||e);
		}

		try {
			schema = parseJson5(await readFile({
				path: schemaPath,
				noTruncate: true
			}, response, global));
			compileSchema(schema);
		} catch (e) {
			return "schema cannot be parsed:\n"+(e.message||e);
		}

		const issues = {};
		validate(data, schema, issues);
		const entries = Object.entries(issues);
		if (entries.length) return "invalid:\n"+entries.map(([k, v]) => k+": "+v).join("\n");
		return "valid";
	},
	title: (req, ctx) => {
		const toolParameters = getToolParameters(ctx, req);
		return "根据 "+toolParameters.schemaPath+" 验证 "+toolParameters.dataPath;
	}
}

registerToolset(
	"JsonEditor",
	"JSON mutation and validation.",
	[EditJson, WriteJson, ValidateJson],
	{
		systemPrompt,
		depend: ["Files"]
	}
);