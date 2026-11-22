import {showToast} from "../components/Toast.js";
import {$cleanup, $watch, debugSymbol, unconscious} from "unconscious";
import {highlightJsonLike} from "../markdown/highlight.js";
import {webviewDownloadFile} from "/vendor/jsBridge.js";
import {auxKeyboardOnly, lastScrollDirectionIsUp} from "../states.js";
import SimpleModal from "../components/SimpleModal.jsx";
import {base64Encode} from "@roj234/shared/base64";
import {DI_messageContainer} from "../hooks.js";
import {jsonFetch} from "/common/fetch-utils.js";
import {throwDOMException} from "/common/pure-utils.js";
import {SHA256} from "unconscious/common/SHA256.js";
import {AS_IS} from "@roj234/shared";
import {callPreviewImage} from "./preview-bridge.js";

export const getRandomString = (length) => {
	const view = new Uint8Array(length);
	crypto.getRandomValues(view);
	return base64Encode(view, true, length * 4 / 3);
}

export const loadingBlock = (message) => <div className={"my-box loading"}>
	<div className="spinner"></div>
	<span>{message}</span>
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

export const onReuse_Callback = debugSymbol("onReuse");
export const ReuseDelegator = (node, item) => node[onReuse_Callback]?.(node, item);

const BLOB_URL = debugSymbol("ObjectUrl");
const BLOB_URL_REFCNT = debugSymbol("ObjectUrlRefCnt");
const BLOB_DATAURL = debugSymbol("DataUrl");

Blob.prototype.toUrl = function() {
	const blob = this;
	blob[BLOB_URL_REFCNT] = (blob[BLOB_URL_REFCNT] ?? 0) + 1;
	return blob[BLOB_URL] ??= URL.createObjectURL(this);
}
Blob.prototype.revokeUrl = function() {
	const blob = this;
	const url = blob[BLOB_URL];
	if (url && ! --blob[BLOB_URL_REFCNT]) {
		URL.revokeObjectURL(url);
		delete blob[BLOB_URL];
	}
}
Blob.prototype.toDataURL = function() {
	const self = this;
	return self[BLOB_DATAURL] ??= new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;
		reader.readAsDataURL(self);
	});
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

	const prefix = (error.name?error.name+": ":"")+(error.message);
	const stackRegex = /at (.*):(\d+):(\d+)\)$/;
	const stackTrace = (error.stack||'').slice(prefix.length).split('\n')
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
	return prefix+"\n"+(stackTrace.join("\n")).trim();
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

export const copyWithAnimation = (data, btn) => {
	const successCallback = btn ? () => {
		btn.className = "ri-checkbox-line ghost";
		setTimeout(() => btn.className = "ri-file-copy-line ghost", 1000);
	} : AS_IS;

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
 * @param {string | File} src
 * @return {JSX.Element}
 * @constructor
 */
export const BlobImage = ({src}) => {
	const isBlob = typeof src !== 'string';
	const dom = <img src={isBlob ? src.toUrl() : src} alt={src.name} loading="lazy" onClick={() => callPreviewImage(src)} />;
	if (isBlob) $cleanup(dom, () => src.revokeUrl());
	return dom;
}

/**
 *
 * @param {string} message
 * @param {Function} confirm
 * @param {Function} cancel
 * @param {boolean} [isKeyboard]
 */
export const deleteWithDrawback = (message, confirm, cancel, isKeyboard) => {
	if (isKeyboard || auxKeyboardOnly) {
		SimpleModal({
			message: '确认删除"'+message+'？',
			accent: 'danger',
			confirmMessage: '删除',
			onConfirm: confirm,
			onCancel: cancel
		});
		return;
	}

	const closeToast = showToast(<>
		<span className="dct-label">即将删除</span>
		<span className="dct-title" title={message}>{message}</span>
	</>, '', 5000, {

		onClose(byTimer) {
			if (byTimer == null) confirm();
			else cancel();
		},
		closeBtn: <button className="dct-undo" onClick={() => closeToast(1)}>撤销</button>
	});
}

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
 * @param {string|Blob|File} blob
 * @param {string} [ext]
 */
export const downloadFile = (blob, ext) => {
	const filename = blob.name || `${APP_NAME}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;

	if (IS_ANDROID_BUILD) {
		webviewDownloadFile(typeof blob === 'string' ? blob : blob instanceof Blob ? blob : blob.toUrl(), filename);
	} else {
		const url = typeof blob === 'string' ? blob : blob.toUrl();
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		queueMicrotask(() => URL.revokeObjectURL(url));
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

/**
 * 只克隆指定名称
 * @param obj
 * @param {Set<string>|string[]} names
 * @return {{}}
 */
export const cloneNamed = (obj, names) => {
	const result = Object.create(null);
	obj = unconscious(obj);
	for (const name of names) {
		if (name in obj) result[name] = obj[name];
	}
	return result;
};

export const requestIdleCallback = window.requestIdleCallback || window.setTimeout;

export const scrollMessagesToBottom = (force) => {
	requestAnimationFrame(() => {
		if (!unconscious(lastScrollDirectionIsUp) || force)
			DI_messageContainer.vl.scrollTo(Number.MAX_SAFE_INTEGER);
	});
};

/**
 *
 * @param {string[]} urlList
 * @param {string} [requiredCapability]
 * @return {Promise<[string, string]>}
 */
export const connectBestServer = async (urlList, requiredCapability) => {
	const nonce = crypto.randomUUID();
	const exceptResult = new SHA256().update(nonce+"AiChat").toString();

	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(new DOMException("连接超时", "TimeoutError")), 10000);

	const testServer = async url => {
		const  { id, pong, cap } = await jsonFetch(url+'ping', {
			signal: timeout.signal,
			body: JSON.stringify({nonce}),
		})
		if (pong === exceptResult) {
			if (requiredCapability && !cap.includes(requiredCapability))
				throwDOMException('请求的能力不可用');
			return id;
		}
		throwDOMException('响应非法');
	};

	let count = urlList.length;

	return new Promise((res, rej) => {
		urlList.forEach((server) => {
			if (!server.endsWith('/')) server += '/';

			testServer(server).then((id) => {
				timeout.abort();
				clearTimeout(timer);
				res(server);
				count--;
			}, (e) => {
				if (!--count) rej(e);
			});
		})
	});
}

export const smartButtonKeyHandler = (el) => {
	const buttons = [...el.querySelectorAll('button')];
	//buttons.forEach((btn, i) => (btn.tabIndex = i === 0 ? 0 : -1));

	const fn = (e) => {
		const idx = buttons.indexOf(document.activeElement);
		if (idx === -1) return;

		let next;
		switch (e.key) {
			case 'ArrowRight':
			case 'ArrowDown': next = (idx + 1) % buttons.length; break;
			case 'ArrowLeft':
			case 'ArrowUp':   next = (idx - 1 + buttons.length) % buttons.length; break;
			case 'Home':      next = 0; break;
			case 'End':       next = buttons.length - 1; break;
			default: return;
		}

		e.preventDefault();
		//buttons[idx].tabIndex = -1;
		//buttons[next].tabIndex = 0;
		buttons[next].focus();
	};
	el.addEventListener('keydown', fn);
	//$cleanup(toolbar, () => toolbar.removeEventListener('keydown', fn));

	return el;
};