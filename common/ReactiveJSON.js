import {createJsonParser} from 'unconscious/common/Json.js';
import {NestedMap} from 'unconscious/common/NestedMap.js';
// TODO 移除对内部API的使用
import {
	$state,
	$unwatch,
	$update,
	$watch,
	$watchWithCleanup,
	__capture,
	__createState,
	appendChildren,
	debugSymbol,
	isReactive,
	unconscious
} from "unconscious";
import {createStreamingMarkdownParser, registerCodeBlockRenderer} from "/src/markdown/markdown.js";
import {EditableMessageRoles, MessageCopyHandler, MessageRoles} from "/src/states.js";
import {JsonEditor} from "/src/components/JsonEditor.jsx";
import {schemaToTypeScriptDefinition, validateAndShowError} from "unconscious/common/json-schema-utils.js";

const IS_FINISHED = debugSymbol('is_finished');
const SYM = debugSymbol("REACTIVE_JSON");

/**
 * 将 JSON Schema 转换为类 TypeScript 接口的文本格式
 * - 减少 tokens 并减少噪音让模型理解更清晰
 * @param {OpenAI.ObjectSchema} schema
 * @param {number} strict
 * @returns {string}
 */
export function schemaToPrompt(schema, strict = 1) {
	const tsDefinition = `\`\`\`typescript
${schemaToTypeScriptDefinition(schema)}
\`\`\``;

	return (strict
			? `### Response format
Respond in valid JSON format strictly conforming to the following TypeScript interface:`
			: `Output only a valid JSON object in code fence strictly matching this TypeScript interface. 
Ensure all required fields are present, types are exact, and no extra fields are added. 
No conversational text or markdown outside the JSON.`
	) + "\n\n" + tsDefinition;
}

/**
 * 用来实现类似 { value && a } 但在 Unconscious 框架下不重新生成元素的效果
 * @param {import("unconscious").Reactive<any>} proxy
 * @param {() => JSX.Element} element
 * @return {import("unconscious").Reactive<JSX.Element>}
 */
export function $once(proxy, element) {
	const output = $state();
	const listener = () => {
		if (unconscious(proxy) != null) {
			output.value = element();
			$unwatch(proxy, listener);
		}
	};
	$watch(proxy, listener);
	return output;
}

/**
 * 创建一个响应式的 Markdown 渲染器
 * @param {HTMLElement} container - 承载渲染内容的 DOM 容器
 * @param {import("unconscious").Reactive<string>} value - 响应式的字符串状态
 * @returns {HTMLElement} 返回容器本身
 */
export function createReactiveMarkdown(container, value) {
	let parser = createStreamingMarkdownParser(container);
	let prevLen = 0;

	if (isReactive(value)) {
		$watchWithCleanup(value, () => {
			const text = unconscious(value) || "";
			parser.write(text.slice(prevLen));
			if (value[IS_FINISHED]) parser.end();
			prevLen = text.length;
		});
	} else {
		parser.write(value);
		parser.end();
	}

	return container;
}

MessageRoles["userPrompt"] = {
	name: "CraftRPG提示块",
	compose(message, output) {
		output.push({
			role: "user",
			content: message.prompt
		});
	},
	renderContent(message, chunks, index, isEditing, messages, defaultRenderContent) {
		chunks.push({
			type: "think",
			think: {
				title: "展开完整提示",
				content: message.prompt
			}
		});
		defaultRenderContent(message, chunks, message.content);
	}
}

/**
 *
 * @param {string} id
 * @param {string} name
 * @param renderer
 * @param compose
 * @param {OpenAI.Schema | function(AiChat.AssistantMessage): OpenAI.Schema} schema
 */
export function registerSchemaMessageRole(id, name, renderer, compose, schema) {
	EditableMessageRoles.add(id);
	MessageRoles[id] = {
		name,
		compose,
		renderContent(message, chunks, index, isEditing) {
			message[MessageCopyHandler] = () => JSON.stringify(message.content, null, 2);

			chunks.push({
				type: "html",
				html: () => {
					if (isEditing(message)) {
						const state = $state();
						$watch(state, () => {
							const val = state.obj;
							if (val) {
								let schema1 = schema;
								if (typeof schema1 === 'function') schema1 = schema(message);
								const error = validateAndShowError(val, schema1);
								if (error) {
									state.value = {error};
									return;
								}
								message.content = val;
							}
						})
						return (<div>
							<JsonEditor value={JSON.stringify(message.content, null, 2)} state={state} />
							{() => state.error && <pre className={"error"} >{state.error}</pre> }
						</div>);
					} else {
						return (<pre className={"code-block"}><code lang={id}>{renderer(message.content)}</code></pre>);
					}
				}
			});
		}
	}

	registerSchemaCodeBlockRenderer(id, renderer);
}

/**
 *
 * @param {string} name
 * @param {function(import("unconscious").Reactive<Object>): import("unconscious").Renderable} renderer
 */
function registerSchemaCodeBlockRenderer(name, renderer) {
	registerCodeBlockRenderer(name, (code, language, node, is_finished) => {
		let rjson = node[SYM];
		if (!rjson) {
			node.previousElementSibling?.remove();
			node[SYM] = rjson = createReactiveJSON();

			const nodes = renderer(rjson[0]);
			appendChildren(node, Array.isArray(nodes) ? nodes : [nodes]);
		}

		rjson[1](code, is_finished);
	});

}


/**
 * 创建一个用于流式 JSON 的响应式对象和更新函数
 *
 * @returns {[import("unconscious").Reactive<Object>, function(json: string, is_finished: boolean): void]} 返回一个元组：
 *   - [0] proxy: 一个响应式代理对象，其属性会随着 JSON 解析进度自动填充
 *   - [1] update: 更新函数，用于传入 LLM 产生的新 JSON 片段
 *
 * @example
 * const [data, update] = createReactiveJSON();
 * $watch(() => data.user.name, (val) => console.log("Name updated:", val));
 * update('{"user": {"name": "Alice"', false);
 */
function createReactiveJSON() {
	/** @type {Map<(string|number)[], import("unconscious").Reactive<any>>} */
	const registry = new NestedMap();
	/**
	 * 内部工厂函数：根据路径和目标对象创建或获取 Proxy
	 * @param {(string|number)[]} path 属性链路径
	 * @return {import("unconscious").Reactive<any>}
	 */
	const createProxy = (path) => registry.get(path) || findProxy(structuredClone(path), __createState());
	/**
	 * @param {(string|number)[]} path 属性链路径
	 * @param {{value: any}} target 遵循 { value, listener } 结构的对象
	 */
	const findProxy = (path, target) => {
		let proxy = registry.get(path);
		if (proxy) return proxy;

		proxy = new Proxy(target, {
			get(t, prop, proxy) {
				//__capture(t);
				if (typeof prop === 'symbol' || prop === "value") return t[prop];

				let value = t.value;
				if (prop === "toJSON") return () => value;
				if (value == null) value = t.value = {};
				if (!(prop in value)) value[prop] = null;

				path.push(prop);
				const childProxy = createProxy(path);
				path.pop();

				__capture(childProxy);
				return childProxy;
			},

			set(t, prop, val) {
				if (prop === "value" || typeof prop === "symbol") {
					t[prop] = val;
					$update(t);
					return true;
				}
			}
		});
		registry.set(path, proxy);
		return proxy;
	};

	const parser = createJsonParser((path, value, is_partial) => {
		const state = createProxy(path);
		state.value = value;
		if (!is_partial) state[IS_FINISHED] = true;

		if (path.length) {
			const lastKey = path.pop();
			const parentState = registry.get(path);
			if (parentState) {
				const parent = unconscious(parentState);
				if (Array.isArray(parent) && lastKey === parent.length) {
					parent.push(state);
				} else {
					parent[lastKey] = state;
				}
				$update(parentState);
			}
			path.push(lastKey);
		}
	});

	let prevLen = 0;
	const proxy = findProxy([], __createState({}));
	const update = (json, is_finished) => {
		parser.write(json.slice(prevLen));
		prevLen = json.length;

		if (is_finished) parser.end();
	};

	return [ proxy, update ];
}
