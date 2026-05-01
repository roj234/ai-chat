export function jsonParse(str, extra) {
	try {
		const v = JSON.parse(str);
		if (extra) {
			for (const key of Object.keys(extra)) {
				if (!v[key]) v[key] = extra[key];
			}
		}
		return v;
	} catch {
		return undefined;
	}
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