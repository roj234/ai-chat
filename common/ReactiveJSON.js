import {StreamJsonParser} from './StreamJsonParser.js';
import {MultiKeyMap} from './MultiKeyMap.js';
// TODO 内部API
import {$update, $watchWithCleanup, __capture, __createState, debugSymbol, unconscious, isReactive} from "unconscious";
import {createMarkdownParser, registerCodeBlockRenderer} from "/src/markdown/markdown.js";
import {EditableMessageRoles, MessageRoles} from "/src/states.js";
import {EditWidget} from "/src/components/EditWidget.jsx";
import {showToast} from "/src/components/Toast.js";

const IS_FINISHED = debugSymbol('is_finished');
const SYM = debugSymbol("REACTIVE_JSON");

/**
 *
 * @param {string} role
 * @param {string} name
 * @param renderer
 * @param compose
 */
export function registerSchemaMessageRole(role, name, renderer, compose) {
	EditableMessageRoles.add(role);
	MessageRoles[role] = {
		name,
		compose,
		getChunks(message, chunks, index, isEditing) {
			chunks.push({
				type: "html",
				html: () => {
					if (isEditing(message)) {
						return (<EditWidget value={JSON.stringify(message.content, null, 2)} onChange={newValue => {
							try {
								message.content = JSON.parse(newValue);
							} catch (e) {
								showToast("JSON Format Error", "error");
							}
						}} />);
					} else {
						return (<pre className={"code-block"}>
							<div className="code-header sticky">
								<span>json_schema ({role})</span>
								<span className="buttons">
									<button className="ri-download-2-line ghost" data-action="save" title="下载代码"></button>
									<button className="ri-file-copy-line ghost" data-action="copy" title="复制代码"></button>
								</span>
							</div>
							<code lang={role} _value={JSON.stringify(message.content)}>{renderer(message.content)}</code>
						</pre>)
					}
				}
			});
		}
	}

	registerSchemaCodeBlockRenderer(role, renderer);
}

/**
 *
 * @param {string} name
 * @param {function(import("unconscious").Reactive<Object>): import("unconscious").Renderable} renderer
 */
export function registerSchemaCodeBlockRenderer(name, renderer) {
	registerCodeBlockRenderer(name, (code, language, node, is_finished) => {
		let rjson = node[SYM];
		if (!rjson) {
			node[SYM] = rjson = createReactiveJSON();

			const [val] = rjson;

			const nodes = renderer(val);
			if (Array.isArray(nodes)) node.replaceChildren(...nodes);
			else node.replaceChildren(nodes);
		}

		const [_, update] = rjson;
		update(code, is_finished);

		// 调试用途
		/*let index = 0;
		const ccb = () => update(code.substring(0, index), false);
		const t = setInterval(() => {
			index++;
			ccb();
			if (index === code.length) {
				update(code, true);
				clearInterval(t);
			}
		}, 10);*/
	});

}

/**
 * 创建一个响应式的 Markdown 渲染器
 * @param {HTMLElement} container - 承载渲染内容的 DOM 容器
 * @param {import("unconscious").Reactive<string>} value - 响应式的字符串状态
 * @returns {HTMLElement} 返回容器本身
 */
export function createReactiveMarkdown(container, value) {
	let parser = createMarkdownParser(container);
	let prevLen = 0;

	if (isReactive(value)) {
		$watchWithCleanup(value, () => {
			const text = unconscious(value) || "";
			parser.write(text.substring(prevLen));
			if (value[IS_FINISHED]) parser.end();
			prevLen = text.length;
		});
	} else {
		parser.write(value);
		parser.end();
	}

	return container;
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
export function createReactiveJSON() {
	/** @type {Map<(string|number)[], import("unconscious").Reactive<any>>} */
	const registry = new MultiKeyMap();
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
				if (prop === "$value") prop = "value";

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

	const parser = StreamJsonParser((path, value, is_partial) => {
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
