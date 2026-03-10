import {$state, $update, debugSymbol, unconscious} from "unconscious";
import {jsonPathOp, parseJsonPath, volatileEnvironment} from "../../skills.js";

const actionLabels = {
	set: '更新', add: '数值变动', append: '获得物品', merge: '属性修正', delete: '移除'
};

const NOT_PERSIST_DATA = debugSymbol("NOT_PERSIST_DATA");

/**
 *
 * @type {AiChat.FunctionTool}
 * @private
 */
export const storage = {
	name: "manage_storage",
	description: "存储和读取数据的工具。支持赋值、数学运算、列表追加及对象操作。",
	parameters: {
		type: "object",
		properties: {
			action: {
				enum: ["get", "set", "add", "append", "merge", "delete"],
				description: "读取, 覆盖, 数值加减, 数组追加, 对象合并, 删除"
			},
			key: {pattern: "^[a-zA-Z]+?[a-zA-Z0-9._]+$", description: "变量名，格式为JSONPath，如 user_pref.likes[0] ，存数据时，应该合理的设计路径，保证路径含义清晰且唯一。"},
			value: {
				type: "value",
				description: "值。仅 set, add, append, merge 需要, add 时传数字（负数为减）, get, delete 不使用该项。"
			}
		},
		required: ["action", "key"],

		// 云端不一定支持这种复杂的约束……事实上，它们甚至会瞎编工具名称
		oneOf: [
			{
				type: "object",
				properties: {
					action: { enum: ["get", "delete"], },
					key: { $ref: "#/properties/key" },
				},
				required: ["action", "key"]
			},
			{
				type: "object",
				properties: {
					action: { enum: ["set", "append"], },
					key: { $ref: "#/properties/key" },
					value: { type: "value", }
				},
				required: ["action", "key", "value"]
			},
			{
				type: "object",
				properties: {
					action: { const: "add", },
					key: { $ref: "#/properties/key" },
					value: { type: "number", }
				},
				required: ["action", "key", "value"]
			},
			{
				type: "object",
				properties: {
					action: { const: "merge", },
					key: { $ref: "#/properties/key" },
					value: { type: "object", }
				},
				required: ["action", "key", "value"]
			},
		],
	},

	autorun: true, // 在对话载入时自动执行script
	script({ action, key, value }, response)  {
		let globalState = unconscious(volatileEnvironment.rp_state);
		if (!globalState) volatileEnvironment.rp_state = $state(globalState = {});

		if (key.startsWith("\"")) key = JSON.parse(key);

		const {value: newValue, undo} = jsonPathOp(globalState, key, action, value);

		if (action !== "get") {
			response[NOT_PERSIST_DATA] = {
				key,
				action,
				value: JSON.stringify(value),
				undo
			};
			$update(volatileEnvironment.rp_state);
		}

		if (action === "set") return "";
		return newValue === undefined ? "undefined" : newValue;
	},
	renderer(response) {
		const data = response[NOT_PERSIST_DATA];
		if (!data) return;

		const { key, action, value } = data;
		return (
			<div className="var-change">
				<span className="var-key">[{key}]</span>
				<span>{actionLabels[action]}: </span>
				<span style={{color: '#2ecc71', fontWeight: 'bold'}}>
					{action === 'add' && value > 0 ? `+${value}` : value}
				</span>
			</div>
		);
	},
	removed(response) {
		const data = response[NOT_PERSIST_DATA];
		if (!data) return;
		const { key, action, undo } = data;

		const globalState = unconscious(volatileEnvironment.rp_state);
		switch (action) {
			case 'delete':
				if (undo._isArray) {
					const paths = parseJsonPath(key);
					const index = paths.pop();
					const {value} = jsonPathOp(globalState, paths, 'get');
					value.splice(index, 0, undo.value);
				}
			case 'set':
			case 'add':
			case 'merge':
				jsonPathOp(globalState, key, undo === undefined ? 'delete' : 'set', undo);
			break;
			case 'append': {
				const {value} = jsonPathOp(globalState, key, 'get');
				value.length = undo;
			}
			break;
		}

		$update(volatileEnvironment.rp_state);
	}
};