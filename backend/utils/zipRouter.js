import {ZipReader} from "unconscious/common/zip-io.js";
import {MIME_TYPES} from "./mime.js";
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {createBrotliDecompress, createInflateRaw} from "node:zlib";


function getContentType(filename) {
	const ext = (filename.lastIndexOf('.') > 0 ? filename.slice(filename.lastIndexOf('.')) : '').toLowerCase();
	return MIME_TYPES[ext] || 'application/octet-stream';
}

// ==================== 路由器工厂函数 ====================
/**
 * 根据 ZIP Blob 创建一个 Node HTTP 请求处理函数
 * @param {ReturnType<typeof ZipReader>} zip
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export function createZipRouter(zip) {
	return async function zipRouter({req, res, path}) {
		if (path.startsWith("/")) path = path.slice(1);
		let entry = zip.entries().get(path);
		if (!entry && (path.endsWith("/") || !path)) entry = zip.entries().get(path += 'index.html');
		if (!entry) return false;

		// ETag：基于 CRC32 的强校验 ETag
		const etag = `"${entry.crc32.toString(16).padStart(8, '0')}"`;
		// Last-Modified
		const lastModified = entry.lastModified.toUTCString();

		// 处理条件请求
		const ifNoneMatch = req.headers['if-none-match'];
		const ifModifiedSince = req.headers['if-modified-since'];
		let notModified;

		if (ifNoneMatch) {
			const tags = ifNoneMatch.split(',').map(t => t.trim());
			if (tags.includes(etag) || tags.includes('*')) {
				notModified = true;
			}
		} else if (ifModifiedSince) {
			const imsDate = new Date(ifModifiedSince);
			if (!isNaN(imsDate.getTime()) && entry.lastModified <= imsDate) {
				notModified = true;
			}
		}

		if (notModified) {
			res.writeHead(304, {
				'ETag': etag,
				'Last-Modified': lastModified,
			});
			res.end();
			return true;
		}

		const compression = entry.compression === 8 ? 'deflate' : entry.compression === 92 ? 'br' : '';

		// 决定是否直接发送 ZIP 中的原始 deflate 数据
		const encodings = (req.headers['accept-encoding'] || '').toLowerCase();
		const accept = encodings.includes(compression);

		let headers = {
			'Content-Type': getContentType(path),
			'Last-Modified': lastModified,
			'ETag': etag,
			'Cache-Control': 'public',
		};

		/** @type {Blob} */
		let body = await zip.getRaw(entry);
		let needDecompress;

		if (compression && accept) {
			// ZIP 中是 deflate 压缩，且客户端接受 deflate → 直接发送原始压缩块
			headers['Content-Encoding'] = compression;
			headers['Content-Length'] = entry.compressedSize;
		} else {
			headers['Content-Length'] = entry.uncompressedSize;
			if (compression) needDecompress = true;
		}

		res.writeHead(200, headers);

		let readable = Readable.from(body);
		if (needDecompress) {
			readable = readable.pipe(compression === 'deflate' ? createInflateRaw() : createBrotliDecompress());
		}
		await pipeline(readable, res);
		return true;
	};
}
