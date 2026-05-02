import http from 'node:http';
import {openZip} from "../../vendor/jszip.js";
import {MIME_TYPES} from "./mime.js";
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream'


function getContentType(filename) {
	const ext = (filename.lastIndexOf('.') > 0 ? filename.slice(filename.lastIndexOf('.')) : '').toLowerCase();
	return MIME_TYPES[ext] || 'application/octet-stream';
}

// ==================== 路由器工厂函数 ====================
/**
 * 根据 ZIP Blob 创建一个 Node HTTP 请求处理函数
 * @param {Blob} zipBlob
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse) => void}
 */
export async function createZipRouter(zipBlob) {
	const zip = await openZip(zipBlob);

	return async function zipRouter({req, res, path}) {
		if (path.startsWith("/")) path = path.slice(1);
		let entry = zip.entries().get(path);
		if (!entry && (path.endsWith("/") || !path)) entry = zip.entries().get(path += 'index.html');
		if (!entry) return false;

		// ETag：基于 CRC32 的强校验 ETag
		const etag = `"${entry.crc.toString(16).padStart(8, '0')}"`;
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

		// 决定是否直接发送 ZIP 中的原始 deflate 数据
		const acceptEncoding = (req.headers['accept-encoding'] || '').toLowerCase();
		const acceptsDeflate = acceptEncoding.includes('deflate');  // 即使是 'deflate, gzip' 也会匹配

		let body;
		let headers = {
			'Content-Type': getContentType(path),
			'Last-Modified': lastModified,
			'ETag': etag,
			'Cache-Control': 'public',
		};

		body = await zip.getRaw(entry);

		let needDecompress;

		if (entry.method === 8 && acceptsDeflate) {
			// ZIP 中是 deflate 压缩，且客户端接受 deflate → 直接发送原始压缩块
			headers['Content-Encoding'] = 'deflate';
			headers['Content-Length'] = entry.compressedSize;
		} else {
			headers['Content-Length'] = entry.uncompressedSize;
			if (entry.method === 8) needDecompress = true;
		}

		const buffer = Buffer.from(await body.arrayBuffer());
		res.writeHead(200, headers);

		if (needDecompress) {
			await pipeline(Readable.from(buffer), new DecompressionStream('deflate-raw'), res);
		} else {
			await pipeline(Readable.from(buffer), res);
		}
		return true;
	};
}
