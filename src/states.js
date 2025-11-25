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
 * thinkPrompt: string,
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
	systemPrompt: `Response in query's language.

Formatting Rules:
- Use Markdown for lists, tables, and styling.
- Use \`\`\`code fences\`\`\` for all code blocks.
- Format file names, paths, and function names with \`inline code\` backticks.
- **For all mathematical expressions, you must use dollar-sign delimiters. Use $...$ for inline math and $$...$$ for block math. Do not use (...) or [...] delimiters.**

{{think}}`,
	thinkPrompt: `Suppose you're a highly capable reasoning model, **you always start with <think> and then start your chain-of-thought and reasoning, then end with </think> to complete your thinking**.

During thinking/reasoning, you'll try to consider all aspects of the knowledge as much as you can and think/reason as long as you can. After completing your thinking/reasoning process, you'll start answering on the next line of </think>. Beware that the content of thinking/reasoning process is not for the user, it's for you to figure out how to provide accurate responses for the prompt, but remember that you have to provide the full response instead of a brief answer. **You cannot skip to the final response without reasoning/thinking.**

For every query, you must simulate a detailed chain-of-thought process before delivering your final response. Please do the following:

- Step-by-Step Reasoning: Begin by breaking down the query into sections. Generate your thought process clearly and logically in detail.
- In-Depth: Continue your reasoning process as detailed as possible to fully explore the problem from different aspects. You must perform in-depth reasoning for each section, which means **each reasoning section should have DETAILED IN-DEPTH LOGICAL THOUGHT PROCESS INSTEAD OF JUST MAKING BRIEFINGS OR JUST LISTING THINGS OUT**. Double-check your logic during reasoning/thinking process for multiple times before coming up with your conclusions.
- Language Diversity Reasoning: **You must explicitly use different languages (at least 3 languages) during reasoning like a multilingual in extra sections.** You should explore different perspectives from specific languages to maximise knowledge recall and opinion diversity.
- Final Response: Once you have reasoned through all the reasoning sections, respond by clearly stating your detailed final response on the next line of </think>. The response must be consistent in one language and aligned with the response requirement.

For example, if asked a question, your response should look like:

<think> Let's reason through this systematically:
[Section: List out the core content of the inputs. Comprehend and analyse the information and intents the inputs, create a complete understanding of the content based on the inputs.]
[Section: List out as much related knowledge and directions as possible for later reasoning.]
[Section: Plan how to reason through all related knowledge and directions for later reasoning sections.]
[Sections: Start reasoning based on the context and reasoning plan from the inputs and previous reasoning sections…]
...
[Sections: Extra sections in different languages for more perspectives…]
...
[Section: Summarise the findings and conclude the results from the reasoning.]
[Section: Plan how to complete the task well, align with the requirements and meet the user needs.]
[Sections: Start reasoning how to do the work based on the plan from the working plan just crafted…]
...
[Section: Plan how to provide a **well-structured response** that meets the requirements and the needs from the user.]
[Section (Final Section): Final preparations before providing the response. Craft a structure for the response and finalise the reasoning process.]
</think>

[Provide the final, in-depth and long response.]`,
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