import {getToolParameters, prefixTitle, registerToolset} from "/src/toolset.js";
import {fileAccess, getChangeableFiles} from "./fileAccess.js";
import {
	compileSchema,
	JSON_POINTER_PATTERN,
	jsonEval,
	parseJsonPointer,
	SCHEMA_VALUES,
	validate,
	validateAndShowError
} from "unconscious/common/json-schema-utils.js";
import {parseJson5} from "unconscious/common/Json.js";

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
			value: {
				type: "object",
				properties: {
					type: { enum: SCHEMA_VALUES },
					value: { type: "value" }
				},
				required: true
			},
		},
		required: ["path", "pointer"]
	},

	async script({path, pointer, value}, response, conv) {
		const text = await readFile({
			path,
			noTruncate: true
		}, response, conv);

		let obj;
		try {
			obj = parseJson5(text);
		} catch (e) {
			throw "File cannot be parsed as JSON5:\n"+e;
		}

		if (!JSON_POINTER_PATTERN.test(pointer))
			throw 'Invalid escape in pointer';

		const jsonPointer = parseJsonPointer(pointer);
		let action = value === undefined ? "delete" : "set";
		if (jsonPointer.at(-1) === '-') {
			action = "push";
			jsonPointer.pop();
		}
		if (jsonPointer.some(s=>!s))
			throw "Found empty property key";

		let type;
		if (value) {
			type = value.type;
			value = value.value;

			const err = validateAndShowError(value, {type});
			if (err) throw err;
		}

		response.undo = jsonEval(obj, jsonPointer, action, value).undo;

		await writeFile({
			path,
			content: JSON.stringify(obj, null, 2),
			overwrite: true
		}, response, conv);
		await getChangeableFiles(conv, path);

		return "Successfully edited /"+jsonPointer.map(JSON.stringify).join("/");
	},
	title: prefixTitle("编辑JSON")
};

/**
 * @type {AiChat.FunctionTool}
 */
const WriteJson = {
	name: "WriteJson",
	description: "Write a JSON file.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			content: { description: "Complete JSON object or array that replaces all existing content.", type: ["object", "array"], },
			indent: { enum: ["", "\t", "  ", "    "], default: "  " }
		},
		required: ["path", "content"]
	},

	async script(par, response, conv) {
		par = { ...par };

		let changeable = await getChangeableFiles(conv);
		if (changeable.has(par.path)) par.overwrite = true;
		par.content = JSON.stringify(par.content, null, par.indent ?? 2);

		const result = await writeFile(par, response, conv);
		changeable.add(par.path);
		return result;
	},
	title: prefixTitle("写入JSON")
}

/**
 * @type {AiChat.FunctionTool}
 */
const ValidateJson = {
	name: "ValidateJson",
	description: `Validate a JSON file (data) based on the JSON schema file.
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
			return "Data cannot be parsed:\n"+(e.message||e);
		}

		try {
			schema = parseJson5(await readFile({
				path: schemaPath,
				noTruncate: true
			}, response, global));
			compileSchema(schema);
		} catch (e) {
			return "Schema cannot be parsed:\n"+(e.message||e);
		}

		const issues = {};
		validate(data, schema, issues);
		const entries = Object.entries(issues);
		if (entries.length) return "Invalid:\n"+entries.map(([k, v]) => k+": "+v).join("\n");
		return "Valid";
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
		default: true,
		depend: ["Files"]
	}
);