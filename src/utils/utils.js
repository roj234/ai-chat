import {showToast} from "../components/Toast.js";
import {$watch, debugSymbol, unconscious} from "unconscious";
import {highlightJsonLike} from "../markdown/highlight.js";
import {webviewDownloadFile} from "/vendor/jsBridge.js";
import {config} from "../states.js";
import {isIDB} from "../database.js";

export const resolveDBRelativeURL = (url) => {
	if (url[0] === '@') {
		if (isIDB) {
			showToast("Could not resolve ["+url+"] in IndexedDB backend");
			return url;
		}

		const backendBase = new URL(config.db_server, document.baseURI).toString();
		const baseDir = backendBase.split('/').slice(0, -3).join('/') + '/';
		url = new URL(url.slice(1), baseDir).toString();
	}
	if (url.endsWith("/")) url = url.slice(0, -1);
	return url;
}

export const loadingBlock = (message, progress) => <div className={"my-box loading"}>
	<div className="spinner"></div>
	<span>{message}</span>
	{progress && <div className={"progress"} style:width={() => unconscious(progress)*100+"%"}></div> }
</div>;

export const errorBlock = (error, title) => {
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
};

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

/**
 * @param {Error | string} error
 * @return {string}
 */
export const prettyError = error => {
	if (typeof error === "string") return error;
	if (!(error instanceof Error)) {
		try {
			return JSON.stringify(error);
		} catch {
			return String(error);
		}
	}

	const stackRegex = /at (.*):(\d+):(\d+)\)$/;
	const stackTrace = (error.stack||'').split('\n').slice(1)
		.map(line => {
			const match = line.match(stackRegex);
			if (match) {
				const fullPath = match[1];
				const lineNumber = match[2];
				let func = fullPath.slice(0, fullPath.indexOf(' ', fullPath.startsWith("async")?6:0)+2);
				// 从路径中提取文件名
				let fileName = fullPath.slice(fullPath.lastIndexOf('/') + 1);
				let start = fileName.match(/[?&]t=\d+/);
				if (start) fileName = fileName.slice(0, start.index);
				return "\tat "+func+line.slice(0, match.index).trim()+`${fileName}:${lineNumber})`;
			}
			return line;
		});
	return (error.message||error.name)+"\n"+(stackTrace.join("\n"));
};

const TIMER = /* #__PURE__ */ Symbol();
const ANIMATION_TIME = 200;

/**
 *
 * @param {HTMLElement} element
 */
export const jsHide = element => {
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
};

export const copyButtonAnimation = (data, btn) => {
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
};

/**
 *
 * @param {AiChat.Message} m
 * @return {string}
 */
export const getTextContent = m => {
	const content = unconscious(m.content);
	return Array.isArray(content) ? content.filter(e => e.type === "text").map(e => e.text).join("\n\n") :  typeof content === "string" ? content : null;
};

/**
 *
 * @param {HTMLElement} element
 */
export const indexInParent = element => Array.prototype.indexOf.call(element.parentElement.children, element);

/**
 * 通过"行为"实现的简单表单-值的响应式绑定
 * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} formElement
 * @param {import('unconscious').Reactive<string>} variable
 */
export const bind = (formElement, variable) => {
	formElement.addEventListener("input", e => {
		variable.value = formElement.value;
	});
	// 因为queueMicrotask在空闲时统一处理事件监听器，所以这不会和上面的input发生递归
	// 除此以外，开发环境本身也有递归检查
	$watch(variable, () => {
		formElement.value = variable.value;
	});

	return formElement;
};

/**
 *
 * @param {Blob|File} blob
 * @param {string} [ext]
 */
export const downloadFile = (blob, ext) => {
	const filename = blob.name || `${APP_NAME}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;

	if (IS_ANDROID_BUILD) {
		webviewDownloadFile(blob instanceof Blob ? blob : blob.toUrl(), filename);
	} else {
		const url = blob.toUrl();
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}
};

/**
 *
 * @param {HTMLElement} element
 * @param {Function} callback
 */
export const updateOnIntersected = (element, callback) => {
	const man = new IntersectionObserver((entries) => {
		if (!entries.at(-1).isIntersecting) return;
		callback();
	});
	man.observe(element);
}