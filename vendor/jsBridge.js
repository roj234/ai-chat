/**
 * @typedef {boolean} IS_ANDROID_BUILD
 * @export
 */

/**
 *
 * @typedef WebViewApi
 * @property {Function} downloadFile
 * @property {Function} downloadBlob
 * @property {Function} blobSavePort
 * @property {Function} uploadImage
 * @property {Function} setUserAgent
 */

const imageUploadPromises = new Map;

window.__imageUploaded = (id, url) => {
	const resolve = imageUploadPromises.get(id);
	if (!resolve) return;
	imageUploadPromises.delete(id);

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

const saveBlobByLocalHttp = (blob, filename) => {
	const port = WebViewApi.blobSavePort();
	const url = `http://127.0.0.1:${port}/save?filename=${encodeURIComponent(filename)}`;
	return fetch(url, {
		method: 'POST',
		body: blob,
	}).catch(e => {
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
	imageUploadPromises.set(id, resolve);
	WebViewApi.uploadImage(id);
});

/**
 * 设置请求的 UserAgent
 * @param {string} ua
 * @return {void}
 */
export const webviewSetUserAgent = (ua) => WebViewApi.setUserAgent(String(ua || ''));
