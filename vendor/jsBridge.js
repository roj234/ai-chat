/**
 * @typedef {boolean} IS_ANDROID_BUILD
 * @export
 */

import {isLanAddress} from "../common/isLanAddress.js";

/**
 *
 * @typedef WebViewApi
 * @property {Function} downloadFile
 * @property {Function} downloadBlob
 * @property {Function} serverPort
 * @property {Function} getToken
 * @property {Function} uploadImage
 * @property {Function} setUserAgent
 * @property {Function} hasAudioPermission
 * @property {Function} requestAudioPermission
 */

const rpc = /* #__PURE__ */ new Map;
let backHandler = null;

if (IS_ANDROID_BUILD) {
	window.__imageUploaded = (id, url) => {
		const resolve = rpc.get(id);
		if (!resolve) return;
		rpc.delete(id);

		if (!url) {
			resolve(null);
		} else {
			fetch(url)
				.then(response => {
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					return response.blob();
				})
				.then(resolve)
				.catch(() => resolve(null));
		}
	};

	window.__audioPermissionResult = (id, granted) => {
		const resolve = rpc.get(id);
		if (!resolve) return;
		rpc.delete(id);
		resolve(granted);
	};

	window.__onBack = () => {
		try {
			if (typeof backHandler === 'function') {
				const r = backHandler();
				if (r === true) return true;
			}
		} catch (e) {
			console.warn('onBack() error', e);
		}
		return false;
	}
}

export const setBackHandler = (fn) => backHandler = fn;

/**
 * @returns {Promise<boolean>}
 */
export const webviewRequestAudio = () => {
	if (WebViewApi.hasAudioPermission()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const id = Date.now() + '_' + Math.random().toString(36).slice(2);
		rpc.set(id, resolve);
		WebViewApi.requestAudioPermission(id);
	});
}

export const webviewStreamDownloadFile = (blob, filename, isLast, id) => {
	const port = WebViewApi.serverPort();
	const token = WebViewApi.getToken();
	let url = `http://127.0.0.1:${port}/save?filename=${encodeURIComponent(filename)}&tk=${token}&last=${isLast?1:0}`;
	if (id != null) url += `&id=${id}`;
	return fetch(url, {
		method: 'POST',
		body: blob,
	}).then(r => r.text(), e => {
		alert(e.message);
	});
};

const saveBlobByLocalHttp = (blob, filename) => {
	const port = WebViewApi.serverPort();
	const token = WebViewApi.getToken();
	const url = `http://127.0.0.1:${port}/save?filename=${encodeURIComponent(filename)}&tk=${token}`;
	return fetch(url, {
		method: 'POST',
		body: blob,
	}).then(r => r.text(), e => {
		alert(e.message);
	});
};

/**
 * 下载文件。url 走 Android DownloadManager；Blob/File 通过本地 HTTP 直传给 Android 写入 Downloads。
 * @param {string | Blob} file
 * @param {string} filename
 * @return {Promise<void> | void}
 */
export const webviewDownloadFile = (file, filename) => {
	filename = String(filename || 'download');
	if (file instanceof Blob) {
		return saveBlobByLocalHttp(file, filename);
	}
	WebViewApi.downloadFile(String(file || ''), filename);
};

/**
 * 拍照上传
 * @return {Promise<Blob | null>}
 */
export const webviewUploadImage = () => new Promise((resolve) => {
	const id = Date.now() + '_' + Math.random().toString(36).slice(2);
	rpc.set(id, resolve);
	WebViewApi.uploadImage(id);
});

/**
 * 设置请求的 UserAgent
 * @param {string | number} ua
 * @return {void}
 */
export const webviewSetUserAgent = (ua) => WebViewApi.setUserAgent(ua || null);

/**
 * 代理 fetch — 绕过 CORS
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<Response>}
 */
export const webviewFetch = (url, options) => {
	if (!isLanAddress(url)) {
		const port = WebViewApi.serverPort();
		const token = WebViewApi.getToken();
		url = `http://127.0.0.1:${port}/proxy?tk=${token}&url=${encodeURIComponent(url)}`;
	}

	return fetch(url, options);
};
