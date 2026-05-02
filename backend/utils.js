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

export function deserializeRow(row) {
	const { data, ...rest } = row;
	return jsonParse(data, rest);
}