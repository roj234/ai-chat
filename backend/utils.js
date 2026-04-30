export function jsonParse(str) {
	try { return JSON.parse(str); } catch { return undefined; }
}

export function getTextContent(message) {
	if (typeof message.content === 'string') return message.content;
	if (Array.isArray(message.content)) {
		return message.content.map(part => {
			if (part.type === 'text') return part.text;
			return '';
		}).join('');
	}
	return '';
}

export function serializeConversation(conv) {
	const { id, title, time, data } = conv;
	return { id, title, time, ...jsonParse(data) };
}