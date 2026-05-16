import {$forElse, $state, $store, $watchWithCleanup, AS_IS, preserveState, unconscious} from 'unconscious';
import {JsonEditor} from '/src/components/JsonEditor.jsx';
import {compileSchema, jsonPathOp} from "unconscious/common/json-schema-utils.js";
import {createMarkdownStream, renderMarkdownToElement} from "../markdown/markdown.js";
import {applyDelta, streamFetch} from "/common/openai-api-utils.js";

// 初始 Schema
const initialSchema = {
	"$schema": "https://json-schema.org/draft/2020-12/schema",
	"title": "StoryTurn",
	"description": "角色扮演/故事叙述中的单轮回合结构",
	"type": "object",
	"properties": {
		"reasoning": {
			"type": "string",
			"description": "展开思考和推理，设想本轮 NPC 的行为：何时、何地、做出什么动作、产生什么后果。时间需要向前推进。"
		},
		"location": {
			"type": "object",
			"description": "本轮发生的地点",
			"properties": {
				"name": {
					"type": "string",
					"description": "地点名称，如「酒馆」「翡翠森林」"
				},
				"description": {
					"type": "string",
					"description": "地点的氛围或细节描写（可选）"
				}
			},
			"required": [
				"name"
			],
			"additionalProperties": false
		},
		"date": {
			"type": "string",
			"format": "date-time",
			"description": "日期与时间，推荐 ISO 8601 格式，如 2025-07-14T08:30:00"
		},
		"mood": {
			"type": "string",
			"description": "本轮整体的氛围/情绪基调，如「紧张」「温馨」「悬疑」（可选）"
		},
		"story": {
			"type": "array",
			"minItems": 1,
			"description": "本轮的叙事片段序列",
			"items": {
				"type": "object",
				"properties": {
					"character": {
						"description": "若为旁白则填 narrator，否则填写角色姓名",
						"anyOf": [
							{
								"const": "narrator"
							},
							{
								"type": "string",
								"minLength": 1
							}
						]
					},
					"content": {
						"type": "string",
						"description": "描写文字或对话内容，支持 Markdown 格式"
					},
					"pose": {
						"type": "string",
						"description": "角色的表情、动作或姿态（可选）"
					}
				},
				"required": [
					"character",
					"content"
				],
				"additionalProperties": false
			}
		},
		"summary": {
			"type": "string",
			"maxLength": 200,
			"description": "200 字以内概括本轮发生的关键事件"
		},
		"variables": {
			"type": "array",
			"description": "需要更新的持久化变量",
			"items": {
				"type": "object",
				"properties": {
					"name": {
						"type": "string",
						"pattern": "^[a-z_][a-z0-9_]*$",
						"description": "变量名，仅限小写字母、数字和下划线"
					},
					"action": {
						"type": "string",
						"enum": [
							"get",
							"set",
							"add",
							"append",
							"merge",
							"delete"
						],
						"description": "操作类型：get-读取, set-覆盖, add-数值累加, append-数组追加, merge-对象合并, delete-删除"
					},
					"value": {
						"description": "操作所需的值（get/delete 时可省略）",
						"oneOf": [
							{
								"type": "string"
							},
							{
								"type": "number"
							},
							{
								"type": "boolean"
							},
							{
								"type": "object"
							},
							{
								"type": "array"
							}
						]
					}
				},
				"required": [
					"name",
					"action"
				],
				"additionalProperties": false
			}
		},
		"suggested_choices": {
			"type": "array",
			"maxItems": 4,
			"description": "若本轮有 {{user}} 参与，为其提供的选项建议。对话用中文引号包裹，行动不加引号。",
			"items": {
				"type": "string",
				"minLength": 1
			}
		}
	},
	"required": [
		"reasoning",
		"location",
		"date",
		"story",
		"summary"
	],
	"additionalProperties": false
};

// 动态 Markdown 渲染组件
const MarkdownText = ({ text }) => {
	const el = <div className="md" />;
	$watchWithCleanup(text, () => {
		el.replaceChildren();
		renderMarkdownToElement(el, unconscious(text));
	});
	return el;
};

const config = $store("config", {
	endpoint: "http://127.0.0.1:8080/v1",
	accessToken: "",
	model: "llama.cpp"
}, {persist: true, deep: false});

const closePopup = ({target}) => {
	target.closest(".modal-backdrop").remove();
};
const SettingPopup = () => document.body.append(
	<div className="modal-backdrop">
		<div className="modal-content">
			<div className="modal-header">
				<h3><i className="ri-settings-line"></i> 模型服务配置</h3>
				<button className="btn-close" onClick={closePopup}>
					<i className="ri-close-line"></i>
				</button>
			</div>
			<div className="modal-body">
				<div>与 AiChat 共享配置，且互相同步</div>
				<div className="form-group">
					<label>API Base URL</label>
					<input
						type="text"
						value={() => config.endpoint}
						onInput={(e) => config.endpoint = e.target.value}
						placeholder="https://api.openai.com/v1"
					/>
				</div>
				<div className="form-group">
					<label>API Key</label>
					<input
						type="password"
						value={() => config.accessToken}
						onInput={(e) => config.accessToken = e.target.value}
						placeholder="sk-114514"
					/>
				</div>
				<div className="form-group">
					<label>Model</label>
					<input
						type="text"
						value={() => config.model}
						onInput={(e) => config.model = e.target.value}
						placeholder="gpt-4o-mini"
					/>
				</div>
			</div>
			<div className="modal-footer">
				<button className="btn btn-primary" onClick={closePopup}>
					保存
				</button>
			</div>
		</div>
	</div>
);

const createTextState = () => {
	let id = 'json';
	let value;
	let storage;
	if (name) {
		id = name;
		value = `// 此链接已失效，请重新打开编辑器`;
		if (opener) {
			storage = {
				setItem(key, value) {
					opener.editorProxy[key] = value;
				},
				getItem(key) {
					return opener.editorProxy[key];
				}
			};
			addEventListener("beforeunload", () => opener.editorProxy.onClose(name));
		}
	} else {
		value = JSON.stringify(initialSchema, null, 2);
		storage = localStorage;
	}

	return $store(id, value, {persist: storage, deep: false, ser: AS_IS, deser: AS_IS});
}

export function App() {
	// Hash加载消息
	const editorText = createTextState();
	const editorObj = $state();

	const isGenerating = preserveState($state(false));
	let inputVal;

	// 对话列表
	const messagesList = preserveState($state([
		{
			hide: true,
			role: "assistant",
			content: `👋 您好！我是您的 **AI 架构助手**。

除了在左侧编辑，你还可以直接指示我修改 Schema。

**几个示例**：
* 增加生命值整数字段，范围是 0-100
* 把生命值改成可选字段
* 加入 status 枚举字段，可以输入 ready started ended

*(也可以让我解释当前的 Schema！)*

这个助手没有上下文，对话时一定要说确切的字段名称，而不是用类似“它”的词来指代`,
			timestamp: new Date().toLocaleTimeString()
		}
	]));

	let chatHistoryEl;

	function scrollToBottom() {
		if (chatHistoryEl) {
			chatHistoryEl.scrollTop = chatHistoryEl.scrollHeight;
		}
	}

	// 复制 JSON 文本
	function handleCopy() {
		const raw = editorObj.obj ? JSON.stringify(editorObj.obj, null, 2) : editorText.value;
		navigator.clipboard.writeText(raw);
		alert("Schema 已成功复制到剪贴板！");
	}

	// 格式化当前编辑器
	function handleFormat() {
		if (editorObj.obj) {
			editorText.value = JSON.stringify(editorObj.obj, null, 2);
		}
	}

	// 真实 AI 接口调用 (支持 Tool Call)
	async function handleSendMessage() {
		const text = inputVal.value.trim();
		if (!text || unconscious(isGenerating)) return;

		const {accessToken: apiKey, endpoint: apiUrl, model: apiModel} = unconscious(config);

		if (!apiKey) {
			alert("请配置API密钥");
			return;
		}

		const userMessage = {
			role: "user",
			content: text,
			timestamp: new Date().toLocaleTimeString()
		};
		messagesList.push(userMessage);

		inputVal.value = "";
		isGenerating.value = true;
		requestAnimationFrame(scrollToBottom);

		// TODO 加上多轮对话和撤销修改
		const apiMessages = [
			{ role: "system", content: `You are an JSON Schema Architect. Your job is to help the user design, modify, and explain JSON Schemas.
Use \`update_json\` which takes a JSON path for partial update, and \`set_json\` for full update.
Whenever the user asks you to modify, add, delete, or optimize fields in the schema, you MUST execute the \`update_json\` tool with the updated schema.
Keep the schema structured, elegant, and strictly compliant with JSON Schema standards.
When delete a property, remember to delete its \`required\` field, too.
Always explain the modifications you made briefly in the message response.
The current JSON Schema is:
\`\`\`json
${editorObj.obj ? JSON.stringify(editorObj.obj) : editorText.value}
\`\`\`
` },
			userMessage
		];

		/**
		 * @type {OpenAI.ObjectSchema}
		 */
		const schema = {
			type: "object",
			properties: {
				updates: {
					type: "array",
					items: {
						type: "object",
						properties: {
							path: { type: "string", },
							value: { type: "value", },
							explanation: {
								type: "string",
								description: "Brief bullet points of what changed."
							}
						},
						required: ["path", "value", "explanation"]
					}
				}
			},
			required: ["updates"]
		};
		compileSchema(schema, true);

		const response = {
			role: "assistant",
			content: "请求中",
			timestamp: new Date().toLocaleTimeString()
		};
		messagesList.push(response);
		let mdr;
		let hasContent;

		const completion = {};
		try {
			await streamFetch(apiUrl+"/chat/completions", {
				key: apiKey,
				body: JSON.stringify({
					model: apiModel,
					messages: apiMessages,
					tools: [
						{
							type: "function",
							function: {
								name: "update_json",
								description: "Updates the active JSON schema via JSONPath (e.g. `$.properties.item.type[1]`), set value = null to delete. Call this whenever the user wants to change elements in the schema.",
								parameters: schema
							}
						},
						{
							type: "function",
							function: {
								name: "set_json",
								description: "Set full JSON schema.",
								parameters: {
									type: "object",
									properties: {
										schema: { type: "object", },
									},
									required: ["schema"]
								}
							}
						}
					],
					stream: true,
					tool_choice: "auto"
				})
			}, chunk => {
				if (!mdr) mdr = createMarkdownStream();

				const {choices, text, ...rest} = chunk;
				let out_choices = completion.choices || (completion.choices = []);
				for (let i = 0; i < choices.length; i++){
					const {delta, ...rest} = choices[i];
					if (!out_choices[i]) out_choices[i] = { delta: {} };

					Object.assign(out_choices[i], rest);
					const delta1 = out_choices[i].delta;
					applyDelta(delta1, delta);

					const {content, reasoning_content} = delta1;
					const mdRenderer = chatHistoryEl.lastElementChild.querySelector(".md");

					if (content && !hasContent) {
						mdr();
						hasContent = true;
					}
					mdr(response.content = content ? (reasoning_content?"<details><summary>已完成思考</summary>"+reasoning_content+"</details>":"") + content : reasoning_content, mdRenderer);
				}
				Object.assign(completion, rest);
			});

			mdr();
			const delta = completion.choices[0].delta;
			if (!response.content) messagesList.pop();

			if (delta.tool_calls?.length) {
				for (const call of delta.tool_calls) {
					const arg = JSON.parse(call.function.arguments);
					if (call.function.name === "update_json") {
						for (let {path, value, explanation} of arg.updates) {
							if (path.startsWith("$.")) path = path.slice(2);

							jsonPathOp(editorObj.obj, path, value == null ? "delete" : "set", value);

							messagesList.push({
								role: "assistant",
								content: `🔧 **[工具：更新 JSON]**\n\n${explanation}`,
								timestamp: new Date().toLocaleTimeString()
							});
						}
					} else if (call.function.name === "set_json") {
						editorObj.obj = arg.schema;
					}
				}

				handleFormat();
			}
		} catch (err) {
			messagesList[messagesList.length - 1] = {
				hide: true,
				role: "assistant",
				content: `🔴 **API 请求发生异常**：\n\`\`\`\n${err.message}\n\`\`\`\n请检查您的配置与网络。`,
				timestamp: new Date().toLocaleTimeString()
			};
			console.error(err);
		} finally {
			isGenerating.value = false;
			setTimeout(scrollToBottom, 50);
		}
	}

	// 绑定 Enter 键发送消息
	function handleKeyPress(e) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSendMessage();
		}
	}

	return (<>

			{/* 左侧：JSON Schema 展示和编辑区 */}
			<section className="panel editor-panel">
				<div className="panel-header">
					<span className="panel-title"><i className="ri-code-s-slash-line"></i> JSON Schema</span>
					<div className="panel-actions">
						<button className="btn-icon" onClick={handleFormat} title="美化">
							<i className="ri-magic-line"></i> 格式化
						</button>
						<button className="btn-icon" onClick={handleCopy} title="复制">
							<i className="ri-file-copy-line"></i> 复制
						</button>
					</div>
				</div>

				<div className="editor-container">
					<JsonEditor value={editorText} state={editorObj} />
				</div>

				{/* 错误诊断控制面板 */}
				{() => (
					editorObj.error ? (
						<div className="editor-error-footer">
							<i className="ri-alert-fill"></i>
							<span className="error-text">{editorObj.error}</span>
						</div>
					) : null
				)}
			</section>

			{/* 右侧：AI 智能对话框 */}
			<section className="panel chat-panel">
				<div className="panel-header">
					<span className="panel-title"><i className="ri-cpu-line"></i> AI 智能修改</span>
					<button className="btn btn-secondary"
							onClick={SettingPopup}>
						<i className="ri-settings-3-line"></i> API 设置
						<div className="ai-mode-status">{() => config.model}</div>
					</button>
				</div>

				{/* 对话历史 */}
				<div className="chat-messages" ref={chatHistoryEl}>
					{$forElse(
						messagesList,
						(msg) => (
							<div className={`chat-bubble-wrapper ${unconscious(msg.role)}`}>
								<div className="chat-avatar">
									{unconscious(msg.role) === 'user' ? (
										<i className="ri-user-6-line"></i>
									) : (
										<i className="ri-robot-2-line"></i>
									)}
								</div>
								<div className="chat-bubble">
									<div className="chat-content">
										<MarkdownText text={() => msg.content} />
									</div>
									<span className="chat-time">{unconscious(msg.timestamp)}</span>
								</div>
							</div>
						),
						<div className="chat-empty">暂无对话记录</div>
					)}
				</div>

				{/* 输入控制台 */}
				<div className="chat-footer">
            <textarea
				className="chat-textarea"
				placeholder="告诉 AI 如何修改，如：'把 location 字段改为可选'..."
				ref={inputVal}
				onKeyDown={handleKeyPress}
				disabled={isGenerating}
			></textarea>
					<button
						className="btn btn-primary btn-send"
						onClick={handleSendMessage}
						disabled={isGenerating}
					>
						{() => unconscious(isGenerating) ? (
							<i className="ri-loader-4-line spin"></i>
						) : (
							<i className="ri-send-plane-fill"></i>
						)}
					</button>
				</div>
			</section>

		</>
	);
}