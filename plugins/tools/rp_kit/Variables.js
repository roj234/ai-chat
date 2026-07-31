import {getToolParameters, updateConversationState} from "/src/toolset.js";
import {jsonEval, jsonEvalUndo, jsonGet, parseJsonPointer} from "unconscious/common/json-schema-utils.js";

const operationLabels = { set: '更新', plus: '增加', push: '追加', delete: '移除' };

/**
 *
 * @type {AiChat.FunctionTool}
 */
export const UpdateVariable = {
	name: "UpdateVariable",
	description: `Update structured state such as inventories, HP, task progress, scores, flags, and temporary simulation data.
Use this for state that must persist in current conversation.

Variable naming: camelCase

Operations:
- set: Overwrite, accepts any type. Missing intermediates are initialized to \`{}\`. Pointer ends with \`/-\` to append \`value\` to the array. (eg: \`/inventory/items/-\`).
- plus: Numeric delta, target must be a number; \`value\` is added as an increment (negative = decrement). If the path does not exist, baseline is 0.
- delete: Remove target: omit \`value\`.  Array element target will be spliced: delete "/inventory/items/1" -> splice index 1

Returns new value at the pointer after the operation completes.`,
	parameters: {
		type: "object",
		properties: {
			// maybe a MOVE(from, to)
			operation: { enum: ["set", "plus", "delete"], },
			pointer: {pattern: `^(?:/[a-zA-Z0-9]+)+(?:/-)?$`, description: `JSON Pointer (RFC 6901)`},
			explanation: {
				type: "string",
				description: "One sentence human-readable summary of why change it."
			},
			value: { type: "value", description: "Omit for delete" },
		},
		required: ["operation", "pointer"]
	},

	reentrant: true,
	script({ operation, pointer, value }, response, conv)  {
		let variables = conv.variables;
		if (!variables) variables = conv.variables = {};

		if (operation === 'plus') {
			try {
				if (typeof value === 'string') value = JSON.parse(value);
			} catch {}

			if (typeof value !== 'number') throw "value must be a number";
		} else if (operation === 'delete') {
			if (value !== undefined)
				throw "value must be omitted for delete operations";
		} else if (value === undefined) {
			throw `value is required for ${operation} operations`;
		}

		const {value: newValue, undo} = jsonEval(variables, parseJsonPointer(pointer), operation, value);

		response.undo = undo;
		updateConversationState(conv, "IS:variables");

		if (operation === "set") {
			if (pointer.endsWith("/-")) {
				return "append to array["+(newValue.length-1)+"]";
			}
			return "updated";
		}
		if (operation === "delete") {
			return newValue ? "deleted" : "not deleted";
		}
		return newValue === undefined ? "undefined" : newValue;
	},
	undo(response, conv, toolCall) {
		const variables = conv.variables;
		const undo = response.undo;
		if (!variables || !undo) return;

		const { pointer, operation } = getToolParameters(response, toolCall);

		jsonEvalUndo(variables, pointer, operation, undo);

		updateConversationState(conv, "IS:variables");
	},
	title(tc, ctx) {
		let { pointer, operation, value } = getToolParameters(ctx, tc);
		if (pointer.endsWith("/-")) {
			pointer = pointer.slice(0, -2);
			operation = 'push';
		}

		return (
			<span>[{parseJsonPointer(pointer).join('.')}] {operationLabels[operation]}: <b style={{
				color: '#2ecc71'
			}}>{operation === 'plus' && value > 0 ? `+${value}` : JSON.stringify(value)?.slice(0, 50)}</b></span>
		);
	},
};

/**
 *
 * @type {AiChat.FunctionTool<{ pointer: string }>}
 */
export const GetVariable = {
	name: "GetVariable",
	parameters: {
		type: "object",
		properties: {
			pointer: {pattern: "^(/[a-zA-Z0-9]+)*$" }
		},
		required: ["pointer"]
	},

	reentrant: true,
	script({ pointer }, response, conv)  {
		const value = jsonGet(conv.variables, pointer);
		return value === undefined ? "undefined" : value;
	},
	title(tc, ctx) { return "读取变量 "+getToolParameters(ctx, tc).pointer; }
};
