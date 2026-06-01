
// 几个落地小建议
// 强制调用：在 API 端把 tool_choice 设为 {"type":"function","function":{"name":"suggest_followups"}}（或循环里检测到没调用就重发一次），比单纯靠提示词更可靠。
// 流式渲染：先把文本回复 stream 给前端，等 tool_call 到达再渲染建议气泡，体验更顺。
// 去重：前端可对 prompt 做归一化（去标点+小写）防止模型给出语义重复项。
// 可选字段 intent 用来做 UI 分组或图标，不需要可以删掉。

import {messages} from "/src/states.js";
import {registerTools} from "/src/skills.js";
import {submitUserChatMessage} from "/src/api-request.js";

const prompt2 = `<Follow-up-Suggestions>
After **EVERY** reply — without exception — you MUST call the
\`suggest_followups\` tool exactly once. The tool call comes AFTER your
natural-language answer completed; never replace the answer with the tool call.

Rules for generating suggestions:

1. LANGUAGE MIRRORING
   - Detect the language of the user's most recent message and write every \`prompt\` in that same language.
   - If the user switches languages mid-conversation, follow the latest message.
   - Set the \`language\` field to the matching BCP-47 code.

2. VOICE
   - Write each \`prompt\` in the FIRST PERSON, as if the user is typing it.
     ✅ "给我推荐几个京都春天必去的景点"
     ❌ "I can recommend Kyoto spring spots for you"
   - Do not include the assistant's name or meta-phrases like "请你帮我…".

3. RELEVANCE & SPECIFICITY
   - Anchor suggestions to concrete nouns from the latest turn (place names, dates, products, file names, numbers). Generic prompts like "再多说一点" are forbidden.
   - Cover a MIX of intents — pick 3–4 from: drill_down, broaden, compare, next_step, clarify, example. Avoid duplicates that differ only in wording.

4. ALWAYS CALL THE TOOL
   - Even for short answers, errors, refusals, or clarification questions, you must still emit \`suggest_followups\`. There is NO scenario where skipping the call is correct.

Example (user just asked about traveling to Kyoto in Chinese):

suggest_followups({
  "language": "zh-CN",
  "suggestions": [
    {"prompt": "推荐几个京都四月赏樱最值得去的景点", "intent": "drill_down"},
    {"prompt": "帮我安排一份京都5天4晚的详细行程", "intent": "next_step"},
    {"prompt": "京都和大阪比，更适合第一次去日本的人吗？", "intent": "compare"},
    {"prompt": "京都有哪些必吃的本地特色美食和推荐店铺？", "intent": "broaden"}
  ]
})
</Follow-up-Suggestions>`;
const prompt = `<Follow-up-Generator>
After current response, call \`suggest_followups\` to provide 3-4 next steps.
The tool call comes AFTER your natural-language answer completed; never replace the answer with the tool call.

## Constraints:
- **Perspective**: User-perspective, First-person (e.g., "Tell me more about..." not "I can tell you more").
- **Language**: Match the user's last message.
- **Quality**: Concrete (use nouns from context), varied (drill down/compare/next step), short (one sentence).

## Example (user just asked about traveling to Kyoto in Chinese):
suggest_followups({
  "language": "zh-CN",
  "suggestions": [
    {"prompt": "推荐几个京都四月赏樱最值得去的景点", "icon": "search"},
    {"prompt": "帮我安排一份京都5天4晚的详细行程", "icon": "rocket"},
    {"prompt": "京都和大阪比，更适合第一次去日本的人吗？", "icon": "scales"},
    {"prompt": "京都有哪些必吃的本地特色美食和推荐店铺？", "icon": "compass"}
  ]
})
</Follow-up-Generator>`;

export const FOLLOWUP_ICON_MAP = {
	// 默认/追问
	"question": "ri-questionnaire-line",

	// 启发/举例
	"lightbulb": "ri-lightbulb-flash-line",

	// 深度挖掘
	"search": "ri-search-2-line",

	// 扩展/探索
	"compass": "ri-compass-3-line",

	// 行动/开始
	"rocket": "ri-rocket-2-line",

	// 对比/平衡
	"scales": "ri-scales-3-line",

	// 事实/验证
	"shield": "ri-shield-check-line",

	// 默认备选 (如果模型抽风输出了非预期的值)
	"default": "ri-chat-follow-up-line"
};


/**
 * @type {AiChat.FunctionTool<{options: string[]}>}
 * @private
 */
const schema = {
	name: "suggest_followups",
	//description: "Provide 3-4 follow-up message suggestions that the user might want to send next, based on the conversation context. " +
	//	"MUST be called once **AFTER** your natural-language answer completed. " +
	//	"Suggestions should be written from the user's first-person perspective (as if the user is typing them), not the assistant's.",
	parameters: {
		type: "object",
		properties: {
			suggestions: {
				type: "array",
				minItems: 3,
				maxItems: 4,
				items: {
					type: "object",
					properties: {
						prompt: {
							type: "string",
							minLength: 4,
							maxLength: 30,
							//description: "The full message that will be sent if the user picks this suggestion. " +
							//	"First-person, concrete, references entities from the prior turn (e.g. '推荐几个京都的赏樱景点' instead of '推荐几个景点')."
						},
						icon: {
							type: "string",
							enum: ["question", "lightbulb", "search", "compass", "rocket", "scales", "shield"],
							description: "The visual category of this suggestion. " +
								"question: general follow-up; " +
								"lightbulb: examples/ideas; " +
								"search: deep dive; " +
								"compass: related topics; " +
								"rocket: next steps; " +
								"scales: comparisons."
						}
					},
					required: ["prompt"],
					additionalProperties: false,
				}
			}
		},
		required: ["suggestions"],
		additionalProperties: false,
	},

	interactive: 'uionly',
	script({suggestions}, response) {
		response.options = suggestions;
	},
	renderer(response, frozen) {
		const removeToolCall = () => {
			const value = messages.value;
			for (let i = value.length - 1; i >= 0; i --){
				const msg = value[i];
				const toolResponses = msg.tool_responses;
				if (!toolResponses) continue;

				const selfIndex = toolResponses.indexOf(response);
				if (selfIndex < 0) return;

				if (selfIndex === 0 && toolResponses.length === 1) {
					delete msg.tool_calls;
					delete msg.tool_responses;
					msg.finish_reason = "stop";
				} else {
					toolResponses.splice(selfIndex, 1);
					msg.tool_calls.splice(selfIndex, 1);
				}
			}
		};

		if (frozen) { removeToolCall(); return; }

		const chooseMessage = (content) => {
			removeToolCall();
			messages.push({role: 'user', content, time: Date.now()});
			submitUserChatMessage();
		}

		return <div className="choice-list" style={"flex-direction: row"}>
			{response.options.map(({prompt, icon}) => (
				<button
					className="choice-item"
					onClick={() => chooseMessage(prompt)}
				>
					<span className={FOLLOWUP_ICON_MAP[icon]}>{prompt}</span>
				</button>
			))}
		</div>;
	}
};

registerTools("followups", "", [schema], {
// TODO 实现manual的可以在UI里手动激活，现在只能通过命令激活
//  还有需要实现动态处理变量，把autorun去掉，改成forward或者可重入？
	hidden: 'manual',
	systemPrompt: prompt
})
