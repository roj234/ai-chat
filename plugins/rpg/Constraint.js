import {createMarkdownStream} from "/src/markdown/markdown.js";
import {APIRequest, getMarkdownContainer, MD_APPEND, MD_END} from "/src/api-request.js";
import {$update, isReactive} from "unconscious";
import {updateMessageUI} from "/src/components/MessageList.jsx";

export async function jsonPrompt(messages, body, custom_renderer_id = 'json') {
	const api = new APIRequest(messages, null, body);

	// Copied only for debug, is not for production
	let markdownRenderer = createMarkdownStream();
	function updateMarkdown(content) {
		const currentIsThink = isReactive(content.think);
		const container = getMarkdownContainer(currentIsThink);
		if (!container) return true;
		markdownRenderer(currentIsThink ? content.think.content : `\`\`\`${custom_renderer_id}
` + content.content, container);
	}

	return await api.call(null, (type, content) => {
		switch (type) {
			case MD_APPEND:
				if (updateMarkdown(content)) break;
				return;
			case MD_END:
				markdownRenderer();
		}
		$update(updateMessageUI);
	});
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
