import {webviewStreamDownloadFile} from "/vendor/jsBridge.js";
import {formatSize} from "unconscious/common/Utils.js";
import {$state} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import {callFileSystemFunc} from "../agent/index.js";
import {downloadFile} from "/src/utils/utils.js";
import {ZipWriter} from "@roj234/jszip/io";
import {createAsyncQueue, formatDuration} from "/common/pure-utils.js";

/** 单次下载的体积上限：1 GiB */
const MAX_DOWNLOAD_SIZE = 1024 ** 3;
/** 超过这个体积就不再压缩，Store 更快也更省内存 */
const MAX_COMPRESS_SIZE = 32 * 1024 ** 2;
/** 小块攒到这个体积再 flush */
const FLUSH_THRESHOLD = 1024 ** 2;
/** 默认打包名 */
const DEFAULT_ARCHIVE_NAME = '下载';

const tooLargeError = (size) => new Error(`体积 ${formatSize(size)}，超过单次 1 GB 的下载上限`);

/**
 * @param {(data: Blob, isLast: boolean) => Promise<void>} send
 * @param {(any) => Promise<void>} [abort]
 */
const bufferedWriter = (send, abort) => {
	let tmp = [];
	let tmpSize = 0;
	return new WritableStream({
		write(arr) {
			if (tmpSize + arr.length > FLUSH_THRESHOLD) {
				const blob = new Blob(tmp);
				tmp = [arr];
				tmpSize = 0;
				return send(blob, false);
			}
			tmp.push(arr);
			tmpSize += arr.length;
		},
		close: () => {
			const blob = new Blob(tmp);
			return send(blob, true);
		},
		abort,
	});
};

/**
 * 挑一种落盘方式
 * @param {string} filename
 * @param {number} [knownSize]
 * @return {FileSystemWritableFileStream | null} null 表示用户关掉了保存对话框
 */
const createDownloadTarget = async (filename, knownSize) => {
	if (IS_ANDROID_BUILD) {
		let id = null;
		const cb = i => id = i;
		return bufferedWriter((blob, isLast) => {
			return webviewStreamDownloadFile(blob, filename, isLast, id).then(cb);
		}, () => {
			//return id && webviewCancelDownloadFile(id);
		});
	}

	if (streamSavingIsSupported) {
		try {
			const handle = await showSaveFilePicker({ suggestedName: filename });
			/**
			 * @type {FileSystemWritableFileStream}
			 */
			const writable = await handle.createWritable();

			return bufferedWriter((blob, isLast) => {
				let p = writable.write(blob);
				if (isLast) p = p.then(() => writable.close());
				return p;
			}, (r) => writable.abort(r));
		} catch (e) {
			if (e?.name === 'AbortError') return;
		}
	}

	if (knownSize > MAX_DOWNLOAD_SIZE) throw tooLargeError(knownSize);
	return null;
};

const streamSavingIsSupported = window.showSaveFilePicker;

/**
 * @typedef {{ name: string, path: string, size: number, mtime?: number }} DownloadJob
 */

/**
 * 下载单个路径
 * @param {AiChat.FileSystemInstance} fs
 * @param {string} path
 * @param {string} name
 * @return {Promise<void>}
 */
export const vfsDownload = (fs, path, name) => vfsDownloadMany(fs, [{ path, name }], name);

const speedMeter = (total, onProgress) => {
	const t0 = performance.now();
	let tLast = t0, bLast = 0;
	let smooth = 0;
	const SAMPLE_MS = 250;

	return (received) =>{
		const t = performance.now();
		const dt = t - tLast;
		if (dt >= SAMPLE_MS) {
			// 瞬时速度
			const instant = ((received - bLast) * 1000) / dt;
			// 指数平滑，时间常数 1s，避免数字乱跳
			const alpha = 1 - Math.exp(-dt / 1000);
			smooth = smooth ? smooth + alpha * (instant - smooth) : instant;

			tLast = t;
			bLast = received;

			const avg = (received * 1000) / (t - t0);
			const pct = total ? received / total : null;
			const eta = smooth > 0 && total ? (total - received) / smooth : null;

			onProgress(pct, {
				received,
				total,
				instant,
				speed: smooth,
				average: avg,
				eta,
			});
		}
	}
}

/**
 * 下载多个文件/文件夹：只有一项且是文件时直接下载，其余情况打包为 zip
 * @param {AiChat.FileSystemInstance} fs
 * @param {{ path: string, name?: string, type?: 'file' | 'dir' }[]} items
 * @param {string} [archiveName] 打包文件名（不含 .zip）
 * @return {Promise<void>}
 */
export const vfsDownloadMany = async (fs, items, archiveName) => {
	const state = $state("正在列目录");

	const cancel = new AbortController();
	const signal = cancel.signal;

	const close = showToast(state, '', 0, {
		closeBtn: <button className="dct-undo" onClick={() => {
			state.value = '正在取消';
			cancel.abort();
		}}>取消下载</button>
	});
	/** @type {DownloadJob[]} */
	const jobs = [];
	/** @type {WritableStreamDefaultWriter} */
	let writer;
	let totalSize = 0;
	try {
		for (const item of items) {
			if (signal.aborted) return;

			const info = item.type === 'dir' ? item : await callFileSystemFunc(fs, 'stat', {
				path: item.path,
				json: true
			});

			if (info.type !== 'dir') {
				jobs.push({ name: item.name, path: item.path, size: info.size, mtime: info.mtimeMs });
				totalSize += info.size;
				continue;
			}

			const files = await callFileSystemFunc(fs, 'list', {
				path: item.path, pattern: "**", json: true, limit: 10000,
				showDir: false, showModified: true, showHidden: true
			});
			for (const [relPath, , size, mtime] of files) {
				jobs.push({
					name: item.name + "/" + relPath,
					path: item.path + "/" + relPath,
					size,
					mtime,
				});
				totalSize += size;
			}
		}

		if (jobs.length === 1 && jobs[0].type !== 'dir') {
			const {name, path, size} = jobs[0];

			const target = await createDownloadTarget(name, totalSize);
			if (target === undefined) return;

			state.value = "正在下载 (无法获取进度)";

			if (target === null) {
				let blob = await callFileSystemFunc(fs, 'readRaw', {path, signal});
				blob = new File([blob], name, { type: blob.type });
				downloadFile(blob);
			} else {
				/** @type {Response} */
				const res = await callFileSystemFunc(fs, 'readRaw', {path, stream: true});
				const total = parseInt(res.headers.get('content-length'), 10) || 0;
				let received = 0;

				const meter = speedMeter(total, (pct, obj) => {
					state.value = name+` ${(pct * 100).toFixed(2)}% (${formatSize(obj.speed)}/s, ETA ${formatDuration(obj.eta)})`
				});

				writer = target;
				await res.body.pipeThrough(new TransformStream({
					transform(chunk, controller) {
						controller.enqueue(chunk);
						meter(received += chunk.byteLength);
					},
				})).pipeTo(target, { signal, preventAbort: true });
			}
		} else {
			const filename = (archiveName||DEFAULT_ARCHIVE_NAME)+".zip";
			const target = await createDownloadTarget(filename, totalSize);
			if (target === undefined) return;

			const startTime = Date.now();
			let downloadSize = 0;
			let downloadCount = 0;

			writer = target?.getWriter();
			const zw = ZipWriter(writer);

			const [enqueue, flush] = createAsyncQueue(4);

			/** @type {Promise<void>} */
			let prevWrite;

			for (let i = 0; i < jobs.length; i++) {
				if (signal.aborted) break;

				const it = jobs[i];
				if (it.size > MAX_DOWNLOAD_SIZE) {
					showToast(`文件 ${it.path} 过大，跳过`, 'error');
					continue;
				}

				await enqueue(async () => {
					const blob = await callFileSystemFunc(fs, 'readRaw', {path: it.path, signal});
					const doWrite = await zw.add(it.name, new Uint8Array(await blob.arrayBuffer()), {
						compression: blob.size < MAX_COMPRESS_SIZE ? 8 : 0,
						lastModified: it.mtime,
					});

					await prevWrite;
					if (signal.aborted) return;
					prevWrite = doWrite();

					downloadCount++;
					downloadSize += blob.size;

					state.value = filename+": "+downloadCount+"/"+jobs.length+` 已下载 (${formatSize(downloadSize)}/${formatSize(totalSize)}}, ${formatSize(downloadSize / (Date.now() - startTime) * 1000)}/s)`;
				});
			}
			await flush();

			const blob = await zw.finish();
			if (writer) {
				await writer.write(blob);
			} else {
				blob.name = filename;
				downloadFile(blob);
			}
		}
	} finally {
		close();
		await writer?.close();
	}
};
