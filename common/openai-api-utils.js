
/**
 * @param {Error} err
 */
const networkErrorHandler = err => {
	if (err.message === "Failed to fetch")
		throw ("网络连接失败\n请检查API地址是否正确，连接是否畅通");
	throw err;
};

/**
 * 发起JSON请求
 * @param {string} url
 * @param {string=} key
 * @param {RequestInit} data
 * @return {Promise<*>}
 */
export const jsonFetch = (url, {key = "", ...data} = {}) => fetch(url, {
	method: data.body ? "POST" : "GET",
	headers: {
		'Accept': 'application/json',
		'Content-Type': "application/json",
		'Authorization': key ? "Bearer " + key : undefined
	},
	referrerPolicy: 'no-referrer',
	...data
})
.catch(networkErrorHandler)
.then(res => {
	if (!res.ok) {
		return res.text().then(err => {
			throw (`API错误 ${res.status}\n${err}`);
		});
	}

	return res.json();
});

/**
 * 发起流式请求
 * @param {string} url
 * @param {string=} key
 * @param {RequestInit} data
 * @param {function(OpenAI.Response): void} onToken
 * @return {Promise<void>}
 */
export const streamFetch = (url, {key = "", ...data} = {}, onToken) => fetch(url, {
	method: "POST",
	headers: {
		'Content-Type': "application/json",
		'Authorization': "Bearer "+(key||'')
	},
	referrerPolicy: 'no-referrer',
	...data
})
.catch(networkErrorHandler)
.then(async res => {
	if (!res.ok) {
		throw {
			status: res.status,
			message: await res.text()
		};
	}
	const contentType = res.headers.get('content-type');
	if (contentType === 'application/json') return onToken(await res.json(), true);

	const reader = res.body.getReader();

	const decoder = new TextDecoder();
	let buf = '';

	try {
		while (true) {
			const {done, value} = await reader.read();
			if (done) break;

			buf += decoder.decode(value, {stream: true});

			const lines = buf.split("\n");
			buf = lines.pop() || '';
			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') return;

					const json = JSON.parse(data);
					let error = json.error;
					try {
						onToken(json);
					} catch (e) {
						if (!error)
							error = e;
					}

					if (error) throw error;
				}
			}
		}
	} finally {
		await reader.cancel();
	}
});


const deltaBlacklist = new Set(["role", "model"]);
/**
 *
 * @param {Object} chunk
 * @param {Object} delta
 */
export const applyDelta = (chunk, delta) => {
	for (const key in delta) {
		const deltaVal = delta[key];
		if (deltaVal == null) continue;

		let currVal = chunk[key];
		if (Array.isArray(deltaVal)) {
			if (!currVal) currVal = chunk[key] = [];

			for (const {index, ...item} of deltaVal) {
				if (index === undefined) { currVal.push(item); continue; }

				// tool_calls
				if (!currVal[index]) currVal[index] = {};
				applyDelta(currVal[index], item);
			}
		} else if (typeof deltaVal === "object") {
			if (!currVal) currVal = chunk[key] = {};
			applyDelta(currVal, deltaVal);
		} else if (typeof currVal === "string" && !deltaBlacklist.has(key)) {
			chunk[key] += deltaVal;
		} else {
			chunk[key] = deltaVal;
		}
	}
};

