import {jsonPrompt} from "../core.js";
import "./Translator.css";
import {$once, createReactiveMarkdown, registerSchemaMessageRole, schemaToPrompt} from "/common/ReactiveJSON.js";
import {$foreach, unconscious} from "unconscious";
import {abortCompletion, config, ensureActiveConversation, messages} from "/src/states.js";
import {COMMAND_REGISTRY} from "/src/commands.js";

const ID = 'aichat/translator';

/**
 * 这个不一定要靠 Schema 实现，但是闲着也是闲着
 * @type {OpenAI.ObjectSchema}
 */
const schema = {
	type: "object",
	properties: {
		context: {
			type: "string",
			description: "思考整段文本的整体语境，整体粗略设计翻译任务"
		},

		translation: {
			type: "array",
			items: {
				type: "object",
				properties: {
					original_text: {
						type: "string",
						description: "一段较为相关，应当一起翻译的文本"
					},
					context: {
						type: "array",
						description: "专业词汇与语境分析",
						items: { type: "string", }
					},
					intent: {
						type: "string",
						description: "意图理解"
					},
					strategy: {
						type: "array",
						description: "制定信、达、雅的翻译策略",
						items: { type: "string", }
					},
					drafts: {
						type: "array",
						description: "翻译草稿与润色",
						items: { type: "string" }
					},
					translated_text: {
						type: "string",
						description: "中文翻译结果"
					}
				},
				required: [
					"original_text",
					"context",
					"intent",
					"strategy",
					"drafts",
					"translated_text",
				],
				additionalProperties: false
			}
		},

		summary: {
			type: "string",
			description: "对本次翻译进行总结"
		},
	},
	required: [
		"context",
		"translation",
		"summary",
	],
	additionalProperties: false
};

/**
 * 生成函数
 * @param {Partial<AiChat.Message>[]} messages_
 * @param {string} prompt
 */
const sendAction = async (messages_, prompt) => {
	await ensureActiveConversation();
	if (unconscious(abortCompletion)) return;

	const time = Date.now();
	const input_messages = [{
		role: "user",
		time,
		content: prompt
	}];

	messages_.push({
		id: -1,
		role: "userPrompt",
		time,
		content: prompt,
		prompt: `
作为精通所有语言的翻译专家，请按下方流程将用户输入翻译为【简体中文】。

${schemaToPrompt(schema, config.jsonSupport)}

## 需要翻译的原文

${prompt}`
	});

	try {
		const assistantResponse = await jsonPrompt(schema, messages_, {
			reasoning: {enabled: false},
			max_completion_tokens: Math.max(8192, prompt.length),
		}, ID);

		const jsonData = JSON.parse(assistantResponse.content);

		input_messages.push({
			...assistantResponse,
			role: ID,
			content: jsonData
		});
	} catch (e) {
		console.error(e);
	}

	messages_.splice(messages_.length - 2, 2, ...input_messages);
};

/**
 * 渲染函数
 * @param {import("unconscious").Reactive<Schema.StoryTurn>} val
 * @return {JSX.Element[]}
 */
const renderer = (val) => {
	return <>
		{$once(val.context, () => (
			<details>
				<summary>语境分析</summary>
				<div>{val.context}</div>
			</details>
		))}
		{$foreach(val.translation, (item) => (
			<div className="trans-card">
				{/* 首行：原文 | 译文 并排 */}
				<div className="card-main">
					<div className="win original">{item.original_text}</div>
					<div className="win translated">
						{createReactiveMarkdown(<div className={"md"}/>, item.translated_text)}
					</div>
				</div>

				{/* CoT 过程折叠 */}
				<details className="cot-details">
					<summary>翻译过程</summary>
					<div className="cot-body">
						{$once(item.context, () => (
							<div className="term-tags">
								{$foreach(item.context, (term) => (
									<span className="tag">{term}</span>
								))}
							</div>
						))}
						{$once(item.intent, () => <div className="intent">{item.intent}</div>)}
						{$once(item.strategy, () => (
							<div className="strategy">
								<ol>
									{$foreach(item.strategy, (s) => <li>{s}</li>)}
								</ol>
							</div>
						))}
						{$once(item.drafts, () => (
							<div className="drafts">
								{$foreach(item.drafts, (draft) => (
									<div className="draft-item">{draft}</div>
								))}
							</div>
						))}
					</div>
				</details>
			</div>
		))}
		{$once(val.summary, () => (
			<details>
				<summary>翻译总结</summary>
				<div>{val.summary}</div>
			</details>
		))}
	</>
};

/**
 * 提示词构造函数
 * @param {AiChat.AssistantMessage & { content: StoryTurn }} msg
 * @param {OpenAI.Message[]} output
 * @param _
 * @param {number} index
 * @param {number} length
 * @param {AiChat.Conversation} conversation
 */
const composer = (msg, output, _, index, length, conversation) => {
	const {content} = msg;
	const {some_variable, ...data} = content;

	output.push({
		role: "assistant",
		content: JSON.stringify(data)
	});
};

// 注册渲染器
registerSchemaMessageRole(ID, '翻译家', renderer, composer, schema);

// 注册命令
COMMAND_REGISTRY["translate"] = [
	(args) => {
		sendAction(messages, args[0].trim());
	},
	"翻译为中文！"
];