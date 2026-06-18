import {getToolParameters, registerTools} from "/src/skills.js";
import {fileAccess, prefixTitle} from "./agent.js";
import {compileSchema, jsonEval, parseJsonPointer, validate} from "unconscious/common/json-schema-utils.js";
import {parseJsonLenient} from "unconscious/common/Json.js";

const systemPrompt = `<json-edit-policy>
### You have three tools for JSON files

- **WriteJson**: Creating a new file, fully rewriting file.
- **EditJson**: Surgically modifying a few nodes in an existing (usually large) file — set, push, or delete.
- **ValidateJson**: Checking whether a JSON file conforms to a given JSON Schema — after edits, before commits, or for debugging.

### JSON Pointer syntax: RFC 6901 with extensions

1. Use \`~0\` and \`~1\` to escape.
2. Trailing \`-\` means append-to-array.

### EditJson

- **Update**: provide \`value\` and a pointer to an existing key or index.
    Missing intermediate nodes are initialized to empty object {}.
- **Push**: use \`/-\` as the final segment; \`value\` is appended to the array.
- **Delete**: **Omit \`value\`** to remove the node at \`pointer\`.
    Array element will be spliced: delete "/items/1" -> splice index 1

### ValidateJson

- Returns a list of "dot-path: error message" pairs on failure.
- Example: $.player[0].inventory[3]: missing required fields: ["name"]

### Anti-patterns (do NOT do)

- Use EditJson to change 90% fields → **WriteJson** the whole file instead.
- Use WriteJson to overwrite a large JSON file just to flip one boolean → **EditJson**.
- Use \`/-\` on non-array → error.
- Skip schema validation after structural edits, then wonder why downstream broke.
</json-tools-policy>`;

const readFile = fileAccess("read");
const writeFile = fileAccess("write");

/**
 * @type {AiChat.FunctionTool}
 */
const EditJson = {
	name: "EditJson",
	description: "Partially update a JSON file by targeting a specific node via JSON Pointer." +
	 " Omit `value` to delete the node at that path.",
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
			format: "raw"
		}, response, global);

		let obj;
		try {
			obj = parseJsonLenient(text);
		} catch {
			throw "Not a valid JSON file";
		}

		const jsonPointer = parseJsonPointer(pointer);
		let action = value === undefined ? "delete" : "set";
		if (jsonPointer.at(-1) === '-' && value) {
			action = "push";
			jsonPointer.pop();
		}

		const undo = jsonEval(obj, jsonPointer, action, value).undo;
		response.undo = undo;

		await writeFile({
			path,
			content: JSON.stringify(obj, null, 2)
		}, response, global);

		return "done. undoHandle="+JSON.stringify(undo);
	},
	title: prefixTitle("编辑JSON")
};

/**
 * @type {AiChat.FunctionTool}
 */
const WriteJson = {
	name: "WriteJson",
	description: "Write or overwrite an JSON file.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			content: { description: "Complete JSON object or array. Replaces all existing content.", type: ["object", "array"], },
		},
		required: ["path", "value"]
	},

	script({path, content}, response, global) {
		return writeFile({path, content: JSON.stringify(content, null, 2)}, response, global);
	},
	title: prefixTitle("写入JSON")
}

/**
 * @type {AiChat.FunctionTool}
 */
const ValidateJson = {
	name: "ValidateJson",
	description: "Validate a JSON file (data) based on the JSON schema file.",
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
			data = parseJsonLenient(await readFile({path: dataPath}, response, global));
		} catch (e) {
			return "json file cannot be parsed\n"+(e.message||e);
		}

		try {
			schema = parseJsonLenient(await readFile({path: schemaPath}, response, global));
			compileSchema(schema);
		} catch (e) {
			return "schema file cannot be parsed\n"+(e.message||e);
		}

		const issues = {};
		validate(data, schema, issues);
		const entries = Object.entries(issues);
		if (entries.length) return "invalid:\n"+entries.map(([k, v]) => k+": "+v).join("\n");
		return "valid";
	},
	title: (req, ctx = {}) => {
		const toolParameters = getToolParameters(ctx, req);
		return "根据 "+toolParameters.schemaPath+" 验证 "+toolParameters.dataPath;
	}
}

export const registerJsonEditor = () => (
	registerTools(
		"JsonEditor",
		"JSON mutation and validation. (depends on 'Files')",
		[EditJson, WriteJson, ValidateJson],
		{systemPrompt}
	)
);
