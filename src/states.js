import {$state, $store} from 'unconscious';

/**
 *
 * @type {{
 * completionTemplate: function(OpenAI.Message[]): string
 * }}
 */
export const state = {
	completionTemplate: null
};

/**
 * @type {Reactive<AiChat.CompletionRequest & AiChat.Provider & {
 * think: boolean,
 * tools: boolean,
 * edit: boolean,
 *
 * keepReasoning: boolean,
 * enforceParam: boolean,
 * debug: boolean,
 *
 * titleModel: string,
 * generateTitle: boolean
 * }>}
 */
export const config = $store("config", {
	endpoint: 'http://localhost:5001/v1',
	accessToken: '',
	mode: 'chat',
	reasoning: false,
	model: 'auto',
	temperature: 1,
	maxTokens: 4096,
	systemPrompt: `You are a helpful assistant. 如果用户用中文提问，请以中文回复。

Formatting Rules:
- Use Markdown for lists, tables, and styling.
- Use \`\`\`code fences\`\`\` for all code blocks.
- Format file names, paths, and function names with \`inline code\` backticks.
- **For all mathematical expressions, you must use dollar-sign delimiters. Use $...$ for inline math and $$...$$ for block math. Do not use (...) or [...] delimiters.**`,

	think: false,
	tools: false,
	edit: false,

	keepReasoning: true,
	enforceParam: true,
	debug: false,

	titleModel: 'deepseek/deepseek-v3.2-exp',
	generateTitle: false,
}, {persist: true});

/**
 * @type {Reactive<AiChat.Message[]>}
 */
export const messages = $state([]);
/**
 * @type {Reactive<AiChat.Conversation>}
 */
export const selectedConversation = $state(null);
/**
 * @type {Reactive<AiChat.Conversation[]> & AiChat.Conversation[]}
 */
export const conversations = $state([]);