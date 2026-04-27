import {showToast} from "../components/Toast.js";
import {$watch, debugSymbol, unconscious} from "unconscious";
import {highlightJsonLike} from "../markdown/highlight.js";

/**
 * 发起API请求
 * @param {string} url
 * @param {RequestInit & { authorization?: string }} data
 * @return {Promise<*>}
 */
export function jsonFetch(url, data = {}) {
	const method = data.body ? "POST" : "GET";
	return fetch(url, {
		method,
		headers: {
			'Accept': 'application/json',
			'Content-Type': "application/json",
			'Authorization': "Bearer "+(data.authorization||"")
		},
		referrerPolicy: 'no-referrer',
		...data
	}).catch(err => {
		if (err.message === "Failed to fetch")
			throw ("网络连接失败\n请检查API地址是否正确，连接是否畅通");
		throw err;
	}).then(res => {
		if (!res.ok) {
			return res.text().then(err => {
				throw (`API错误 ${res.status}\n${err}`);
			});
		}

		return res.json();
	});
}


/**
 * 只克隆指定名称
 * @param obj
 * @param {Set<string>|string[]} names
 * @return {{}}
 */
export function cloneNamed(obj, names) {
	const result = {};
	obj = unconscious(obj);
	for (const name of names) {
		if (name in obj) result[name] = obj[name];
	}
	return result;
}

export const IN_EDIT_MODE = debugSymbol("EDIT");

export function loadingBlock(message) {
	return <div className={"my-box loading"}>
		<div className="spinner"></div>
		<span>{message}</span>
	</div>;
}

export function errorBlock(error, title) {
	let safeHtml;
	if (typeof error !== "string") {
		if (error instanceof Error) {
			error = prettyError(error);
		} else {
			error = highlightJsonLike(error);
			safeHtml = true;
		}
	} else {
		safeHtml = /[\[{"]/.test(error[0]);
		if (safeHtml) error = highlightJsonLike(error);
	}

	const pre = <pre className="error-text" ></pre>;
	pre[safeHtml?"innerHTML":"textContent"] = error;
	return <div className="error-block" style={title && "--title:" + JSON.stringify(title)}>{pre}</div>;
}

export const MORPH_CHILD_FUNCTION = debugSymbol("MORPH_CHILD_FUNCTION");
export const MORPH_CHILD_HANDLER = (key, node) => {
	const fn = node[MORPH_CHILD_FUNCTION];
	fn && fn(key, node);
};

const BLOB_URL = debugSymbol("BLOB_URL");
const BLOB_DATAURL = debugSymbol("BLOB_DATAURL");

Blob.prototype.toUrl = function() {
	return this[BLOB_URL] || (this[BLOB_URL] = URL.createObjectURL(this));
}
Blob.prototype.toDataURL = function() {
	const self = this;
	return self[BLOB_DATAURL] || (self[BLOB_DATAURL] = new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;
		reader.readAsDataURL(self);
	}));
}

export function limitMaxSide(width, height, maxSide) {
	if (width > maxSide || height > maxSide) {
		if (width > height) {
			height = (height / width) * maxSide;
			width = maxSide;
		} else {
			width = (width / height) * maxSide;
			height = maxSide;
		}
	}
	return [width, height];
}

/**
 * 压缩图片
 * @param {Blob} file - 输入的原始图片文件
 * @param {number=} quality - 压缩质量 (0-1)
 * @param {number=} maxSide - 长边限制
 * @param {number=} maxSize - 最大大小
 * @returns {Promise<Blob>} - 返回压缩后的 JPEG Blob
 */
export async function compressImage(file, { quality = 0.85, maxSide = 2048, maxSize = 2097152 } = {}) {
	const imageBitmap = await createImageBitmap(file);

	try {
		let { width, height } = imageBitmap;
		if (width <= maxSide && height <= maxSide && file.size <= maxSize) return file;

		[width, height] = limitMaxSide(width, height, maxSide);

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');

		ctx.fillStyle = '#FFFFFF';
		ctx.fillRect(0, 0, width, height);

		ctx.drawImage(imageBitmap, 0, 0, width, height);

		for (;;) {
			let result = await canvas.convertToBlob({
				type: 'image/jpeg',
				quality: quality
			});

			if (result.size <= maxSize || quality <= 0.5) return result;
		}
	} finally {
		imageBitmap.close();
	}
}

export function* deepEntries(obj, seen = new Set()) {
	if (obj === null || typeof obj !== 'object') return;
	if (seen.has(obj)) return;
	seen.add(obj);

	for (const key of Object.getOwnPropertyNames(obj)) {
		const value = obj[key];
		yield [value, obj, key];
		if (value && typeof value === 'object') {
			yield* deepEntries(value, seen);
		}
	}
}

/**
 * @param {Error | string} error
 * @return {string}
 */
export function prettyError(error) {
	if (typeof error === "string") return error;
	if (!(error instanceof Error)) {
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}

	const stackRegex = /((?:https?|file|webpack|node|app):.*):(\d+):(\d+)/;
	const stackTrace = error.stack.split('\n').slice(1)
		.map(line => {
			const match = line.match(stackRegex);
			if (match) {
				const fullPath = match[1];
				const lineNumber = match[2];
				// 从路径中提取文件名
				const fileName = fullPath.substring(fullPath.lastIndexOf('/') + 1);
				return "\t"+line.substring(0, match.index).trim()+`${fileName}:${lineNumber})`;
			}
			return null;
		});
	return (error.message||error.name)+"\n"+(stackTrace.join("\n"));
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

export function copyButtonAnimation(data, btn) {
	const successCallback = () => {
		btn.className = "ri-checkbox-line ghost";
		setTimeout(() => btn.className = "ri-file-copy-line ghost", 1000);
	};

	if (navigator.clipboard) {
		navigator.clipboard[typeof data === "string" ? 'writeText' : 'write'](data)
			.then(successCallback)
			.catch(() => showToast('复制失败'));
	} else {
		const input = <input value={data} />
		document.body.append(input);
		input.select();
		document.execCommand('copy');
		input.remove();
		successCallback();
	}
}

/**
 * 节流函数，保证最终一定会以最新的参数调用一次
 * @template {Function} T
 * @param {T} fn
 * @param {number} wait=300
 * @return {T}
 */
export function throttled(fn, wait = 300) {
	let timer;
	let latestArgs;
	const again = (...args) => {
		if (timer) {
			latestArgs = args;
		} else {
			timer = setTimeout(() => {
				timer = 0;
				fn(...args);
				if (latestArgs) {
					again(...latestArgs);
					latestArgs = 0;
				}
			}, wait);
		}
	};
	return again;
}

/**
 *
 * @param {string} url
 * @param {RequestInit & { authorization?: string }} data
 * @param {function(OpenAI.Response): void} onToken
 * @return {Promise<void>}
 */
export function streamFetch(url, data = {}, onToken) {
	return fetch(url, {
		method: "POST",
		headers: {
			'Content-Type': "application/json",
			'Authorization': "Bearer "+(data.authorization||"")
		},
		referrerPolicy: 'no-referrer',
		...data
	}).then(async res => {
		if (!res.ok) {
			const err = await res.text();
			throw (`API错误 ${res.status}\n${err}`);
		}

		const reader = res.body.getReader();

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
						let error = json.error?.message;
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
}

/**
 *
 * @param {AiChat.Message} m
 * @return {string}
 */
export function getTextContent(m) {
	return Array.isArray(unconscious(m.content)) ? m.content.filter(e => e.type === "text").map(e => e.text).join("\n\n") : m.content;
}

/**
 *
 * @param {HTMLElement} element
 */
export function indexInParent(element) {return Array.prototype.indexOf.call(element.parentElement.children, element);}

export function once(callback) {
	let result;
	return () => {
		if (callback) {
			result = callback();
			callback = null;
		}
		return result;
	}
}


/**
 * 通过"行为"实现的简单表单-值的响应式绑定
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} formElement
 * @param {import('unconscious').Reactive<string>} variable
 */
export function bind(formElement, variable) {
	formElement.addEventListener("input", e => {
		variable.value = formElement.value;
	});
	// 因为queueMicrotask在空闲时统一处理事件监听器，所以这不会和上面的input发生递归
	// 除此以外，开发环境本身也有递归检查
	$watch(variable, () => {
		formElement.value = variable.value;
	});

	return formElement;
}
