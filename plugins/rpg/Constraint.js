import {markdownStreamParser} from "/src/markdown/markdown.js";
import {APIRequest, getMarkdownContainer, MD_APPEND, MD_END} from "/src/api-request.js";
import {$update, isReactive} from "unconscious";
import {updateMessageUI} from "/src/components/MessageList.jsx";
import {messages} from "/src/states.js";

export async function jsonPrompt(messages_, body, custom_renderer_id = 'json') {
	messages.value = messages_;

	const api = new APIRequest(messages, null, body);

	// Copied only for debug, is not for production
	let markdownRenderer = markdownStreamParser();
	function updateMarkdown(content) {
		const currentIsThink = isReactive(content.think);
		const container = getMarkdownContainer(currentIsThink);
		if (!container) return true;
		markdownRenderer(currentIsThink ? content.think.content : `\`\`\`${custom_renderer_id}
` + content.content, container);
	}

	const response = await api.call(null, (type, content) => {
		switch (type) {
			case MD_APPEND:
				if (updateMarkdown(content)) break;
				return;
			case MD_END: markdownRenderer();
		}
		$update(updateMessageUI);
	});

	const data = JSON.parse(response.content);
	response.content = `\`\`\`${custom_renderer_id}
` + response.content + "\n```";
	$update(messages);

	return data;
}

export function schemaWrapper(name, schema) {
	return {
		response_format: {
			type: "json_schema",
			json_schema: {
				name,
				strict: true,
				schema
			}
		}
	};
}
