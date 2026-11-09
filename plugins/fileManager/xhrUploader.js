/* ================= 分片上传核心 ================= */
import {prettyError} from "../../src/utils/utils.js";
import {abortable, sleep} from "../../common/pure-utils.js";

const CHUNK_DEFAULT = 8 << 20;
const CHUNK_MAX     = 64 << 20;
const CHUNK_MIN     = 1 << 20;
const MAX_RETRY     = 5;

/**
 * @param {string} text
 * @param {number} status
 * @return {string}
 */
function errText(text, status) {
	const t = (text || '').trim();
	try {
		const o = JSON.parse(t);
		if (o && o.error) return prettyError(o.error);
	} catch {}
	if (!t) return 'HTTP ' + status;
	if (/^<(!doctype|html|head)/i.test(t)) return `服务返回的响应格式有误：${status} （检查地址或反向代理）`;
	return t;
}

/** 目标 ~64 片，只在 [4 MiB, 16 MiB] 内上调；小文件单片直传 */
function pickChunkSize(size) {
	if (size <= CHUNK_DEFAULT) return size;
	let c = CHUNK_DEFAULT;
	while (c < size / 64 && c < CHUNK_MAX) c <<= 1;
	return c;
}

function getDelay(attempt, retryAfter) {
	if (retryAfter) return Math.min(retryAfter * 1000 || 0, 60_000);
	const base = 400 * 2 ** (attempt - 1);
	return base * (1 + Math.random() * 0.5);
}

/**
 * @param {File}   file
 * @param {string} url
 * @param {object} headers
 * @param {function} onProgress  (0..1) => void，单调递增
 * @param {AbortSignal} signal
 */
export async function xhrUpload(file, url, headers = {}, signal, onProgress) {
	const total = file.size;

	let allFin = 0;
	let chunkFin = 0;

	let chunkSize = pickChunkSize(total);
	let offset = 0;
	let attempt = 0;

	onProgress(0);

	while (offset < total) {
		const end  = Math.min(offset + chunkSize, total);
		const blob = file.slice(offset, end);   // slice 是零拷贝视图

		let xhr;
		try {
			xhr = await new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();
				xhr.open('POST', url);
				xhr.setRequestHeader('Content-Type', 'application/octet-stream');
				xhr.setRequestHeader('Content-Range', `bytes ${offset}-${end - 1}/${total}`);
				if (offset === 0) xhr.setRequestHeader('If-None-Match', '*');
				for (const k in headers) xhr.setRequestHeader(k, headers[k]);

				// 约 64 KiB/s 的悲观下限
				xhr.timeout = Math.ceil(blob.size / (64 * 1024)) * 1000;

				xhr.upload.onprogress = e => {
					if (!e.lengthComputable) return;
					chunkFin = e.loaded;
					onProgress((allFin + chunkFin) / file.size);
				};
				xhr.onload = () => resolve(xhr);
				xhr.onerror = () => reject(new DOMException('', 'NetworkError'));
				xhr.ontimeout = () => reject(new DOMException('', 'TimeoutError'));
				xhr.onabort = () => reject(signal.reason);

				signal.addEventListener('abort', () => xhr.abort());
				xhr.send(blob);
			});
		} catch (e) {
			if (e.name === 'AbortError' || signal.aborted || ++attempt > MAX_RETRY) throw e;
			await abortable(sleep(getDelay(attempt)), signal);
			continue;
		}

		const st = xhr.status;
		if (st >= 200 && st < 300) {
			allFin += chunkFin;
			chunkFin = 0;
			offset = end;
			attempt = 0;
			continue;
		}

		if (st === 412) throw new DOMException('同名文件已存在', 'InvalidStateError');

		if (st === 413 && chunkSize > CHUNK_MIN) {
			chunkSize = Math.max(CHUNK_MIN, chunkSize >> 1);
			continue;
		}

		if (st === 416) throw new DOMException('续传位置与服务器不一致', '');

		const retryable = st === 408 || st === 425 || st === 429 || (st >= 500 && st < 600);
		if (retryable && ++attempt <= MAX_RETRY) {
			await abortable(sleep(getDelay(attempt, Date.parse(xhr.getResponseHeader('Retry-After')))), signal);
			continue;
		}
		throw new DOMException(errText(xhr.responseText, st), 'NetworkError');
	}

	onProgress(1);
}