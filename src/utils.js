import {showToast} from "./Toast.js";

/**
 *
 * @type {{
 *     scroller: HTMLElement,
 *     messages: HTMLElement,
 *     sendBtn: HTMLButtonElement,
 *     statusBadge: HTMLElement
 * }}
 */
export const Elements = {}

/**
 * @param {Error | string | Object} err
 * @return {string}
 */
export function prettyError(err) {
	if (!err) return "未知错误";
	if (typeof err === 'string') return err;
	if (err instanceof Error) return err.message;
	try {
		return JSON.stringify(err);
	} catch {
		return String(err);
	}
}

const TIMER = /* #__PURE__ */ Symbol();
const ANIMATION_TIME = 200;

/**
 *
 * @param {HTMLElement} element
 */
export function jsHide(element) {
	clearTimeout(element[TIMER]);

	if (!element.style.display) {
		element.style.left = "-"+element.offsetWidth+"px";
		element[TIMER] = setTimeout(() => {
			element.style.display = "none";
		}, ANIMATION_TIME);
	} else {
		element.style.display = "";
		element[TIMER] = setTimeout(() => {
			element.style.left = "";
		});
	}
}

export function copy(txt, btn) {
	navigator.clipboard.writeText(txt)
		.then(() => {
			btn.className = "i checked";
			setTimeout(() => btn.className = "i copy", 1000);
		})
		.catch(() => showToast('复制失败'));
}

/**
 * 节流函数，保证最终一定会以最新的参数调用一次
 * @template {Function} T
 * @param {T} fn
 * @param {number} wait=300
 * @return {T}
 */
export function throttle(fn, wait = 300) {
	let t = false;
	let onceMore = false;
	const again = (...args) => {
		if (t !== false) {
			onceMore = true;
		} else {
			t = setTimeout(() => {
				fn(...args);
				t = false;
				if (onceMore) {
					onceMore = false;
					again();
				}
			}, wait);
		}
	};
	return again;
}

/**
 * SSE parsing and streaming
 * @param {Response} response
 * @param {function(OpenAI.ChatCompletionChunk | OpenAI.ChatCompletionResponse): void} onToken
 * @return {Promise<void>}
 */
export async function readSSEStream(response, onToken) {
	const reader = response.body.getReader();

	const decoder = new TextDecoder();
	let buf = '';

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });

			const lines = buf.split("\n");
			buf = lines.pop() || '';
			for (const line of lines) {
				if (line.startsWith('data: ')) {
					const data = line.slice(6);
					if (data === '[DONE]') return;

					const json = JSON.parse(data);
					onToken(json);

					if (json.error) throw json.error.message;
				}
			}
		}
	} finally {
		await reader.cancel();
	}
}

/**
 *
 * @param {AiChat.Message} m
 * @return {string}
 */
export function getTextContent(m) {
	return Array.isArray(m.content) ? m.content.filter(e => e.type === "text")[0]?.text : m.content;
}