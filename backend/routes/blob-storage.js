import {join} from 'node:path';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';

export function registerBlobRoutes(router, blobDir) {
	// 1. 确保目录存在 (改为异步初始化)
	mkdir(blobDir, { recursive: true });

	// 获取文件路径的辅助函数
	const getPaths = (hash) => ({
		dataPath: join(blobDir, hash),
		metaPath: join(blobDir, `${hash}.type`)
	});

	// 下载 Blob
	router.get('blob/:hash', async (ctx) => {
		const { dataPath, metaPath } = getPaths(ctx.params.hash);

		try {
			// 检查文件是否存在
			const stats = await stat(dataPath);
			const lastModified = new Date(stats.mtimeMs).toUTCString();

			const ifModifiedSince = ctx.req.headers['if-modified-since'];
			if (ifModifiedSince) {
				const imsDate = new Date(ifModifiedSince);
				if (!isNaN(imsDate.getTime()) && stats.mtimeMs <= imsDate) {
					ctx.res.writeHead(304, {
						'Content-Length': 0,
						'Last-Modified': lastModified,
					});
					ctx.res.end();
					return;
				}
			}

			// 读取 MIME 类型 (这里是 O(1) 操作，直接定位文件)
			const contentType = await readFile(metaPath, 'utf8').catch(() => 'application/octet-stream');

			ctx.res.writeHead(200, {
				'Content-Type': contentType,
				'Cache-Control': 'public, max-age=31536000, immutable',
				'Last-Modified': lastModified
			});

			await pipeline(createReadStream(dataPath), ctx.res);
		} catch (err) {
			if (err.code === 'ENOENT') {
				ctx.send(404, { error: 'not found' });
			} else {
				throw err;
			}
		}
	});

	// 上传 Blob
	router.post('blob/:hash', async (ctx) => {
		const hash = ctx.params.hash;
		const contentType = ctx.req.headers['content-type'] || 'application/octet-stream';
		const { dataPath, metaPath } = getPaths(hash);

		try {
			// 并行写入：保存二进制数据和 MIME 类型
			await Promise.all([
				pipeline(ctx.req, createWriteStream(dataPath)),
				writeFile(metaPath, contentType)
			]);

			ctx.send(201, { hash });
		} catch (err) {
			ctx.send(500, { error: 'Upload failed', detail: err.message });
		}
	});
}