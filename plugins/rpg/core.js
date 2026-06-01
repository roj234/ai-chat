import {createMarkdownStream} from "/src/markdown/markdown.js";
import {APIRequest, findStreamingContainer, MARKDOWN_APPEND, MARKDOWN_END} from "/src/api-request.js";
import {$update, AS_IS, isReactive} from "unconscious";
import {updateMessageUI} from "/src/components/MessageList.jsx";
import {abortCompletion, config} from "/src/states.js";

export const jsonPrompt = async (schema, messages, body, custom_renderer_id = 'json') => {
	const supportLevel = config.jsonSupport;
	if (supportLevel) {
		body.response_format = supportLevel <= 1
			? { type: "json_object" }
			: {
				type: "json_schema",
				json_schema: {
					name: "schema",
					strict: true,
					schema
				}
			};
	}

	const api = new APIRequest(messages, null, body);

	const removeCodeFence = config.jsonSupport ? AS_IS : s => s.replace(/^\s*```json|```$/, "").trim();

	let markdownRenderer = createMarkdownStream();
	const updateMarkdown = msg => {
		const thinking = isReactive(msg.think);
		const container = findStreamingContainer(thinking);
		if (!container) return true;
		markdownRenderer(thinking ? msg.think.content : `\`\`\`${custom_renderer_id}
` + removeCodeFence(msg.content), container);
	};

	api.abort = abortCompletion;
	try {
		const [message, log] = await api.call(null, (type, content) => {
			switch (type) {
				case MARKDOWN_APPEND:
					if (updateMarkdown(content)) break;
					return;
				case MARKDOWN_END:
					markdownRenderer();
			}
			$update(updateMessageUI);
		});

		message.content = removeCodeFence(message.content);

		/*log.id = -1;
		log._type = "jsonApi/"+custom_renderer_id;
		await appendBillingLog(log);*/

		return message;
	} finally {
		abortCompletion.value = null;
	}
};

