import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

// ---------- 工具函数（直接从原 fs-api.js 迁移） ----------

/**
 * 行内容缓存（WeakRef）
 * @type {Map<string, WeakRef<string[]>>}
 */
const cache = new Map;

/**
 * 路径索引（暂未使用，保留）
 * @type {Map<string, string>}
 */
const fileIndex = new Map;

/**
 * 安全工具：路径校验
 * @param {RouteContext} ctx
 * @param {string} relPath
 * @return {*|string}
 */
export function pathFilter(ctx, relPath) {
	if (fileIndex.has(relPath)) return fileIndex.get(relPath);
	const targetPath = path.resolve(ctx.sandboxRoot, relPath.replace(/^\/+/, ''));
	if (!targetPath.startsWith(ctx.sandboxRoot)) {
		const err = new Error('Forbidden: Path Traversal');
		err.statusCode = 403;
		throw err;
	}
	return targetPath;
}

function shaHash(content, len = 4) {
	return crypto.createHash('sha-1').update(content).digest('hex').substring(0, len).toUpperCase();
}

function parseHash(hash, lines) {
	if (hash === '#END') return lines.length;
	const idx = hash.indexOf('#');
	const lineNo = parseInt(hash.substring(0, idx)) - 1;
	const line = lines[lineNo];
	if (line && shaHash(line) === hash.substring(idx + 1)) return lineNo;
	return lines.indices.indexOf(hash);
}

/**
 *
 * @param {string} filePath
 * @return {Promise<string[]>}
 */
async function readLines(filePath) {
	const { mtime } = await fs.stat(filePath);
	let lines = cache.get(filePath)?.deref();
	if (!lines || lines.mtime < mtime) {
		const content = await fs.readFile(filePath, 'utf-8');
		lines = content.split(/\r?\n/);
		lines.indices = lines.map((line, i) => `${i + 1}#${shaHash(line)}`);
		lines.mtime = Date.now();
		cache.set(filePath, new WeakRef(lines));
	}
	return lines;
}

// ---------- 路由注册 ----------

export function registerFsRoutes(router) {
	// 辅助：发送非 JSON 响应（如图片、文本）
	function sendRaw(res, status, contentType, data) {
		res.writeHead(status, { 'Content-Type': contentType });
		res.end(data);
	}

	// 1. 读取文件或目录内容
	router.post('read', async (ctx) => {
		const { path: filePath, begin, end, max_chars = 10000 } = await ctx.readBody();
		const safePath = pathFilter(ctx, filePath);
		const stats = await fs.stat(safePath);
		if (stats.size > 10485760) {
			return ctx.send(400, { error: `File too big (${stats.size} bytes)` });
		}

		const ext = safePath.slice(safePath.lastIndexOf('.') + 1).toLowerCase();
		// 图片直接返回二进制
		if (['png', 'jpg', 'bmp', 'jpeg'].includes(ext)) {
			const data = await fs.readFile(safePath);
			return sendRaw(ctx.res, 200, `image/${ext}`, data);
		}

		const lines = await readLines(safePath);
		const start = begin ? begin - 1 : 0;
		const stop = end ? Math.min(end, lines.length) : lines.length;
		let limit = max_chars;
		let truncated = 0;
		const respLines = [];

		for (let i = start; i < stop; i++) {
			const line = lines[i];
			if (limit <= line.length) {
				truncated = stop - i;
				break;
			}
			limit -= line.length;
			respLines.push(lines.indices[i] + `| ${line}`);
		}

		let content = truncated
			? `Warning: max_chars reached, truncated ${truncated} lines\n`
			: '';
		content += `Total lines: ${lines.length}\nReturned lines: ${respLines.length}\n\nLine#Tag| Content\n${respLines.join('\n')}`;
		sendRaw(ctx.res, 200, 'text/plain', content);
	});

	// 2. 替换文件内容（按标签）
	router.post('replace', async (ctx) => {
		const { path: filePath, start_tag, end_tag, lines: newLines } = await ctx.readBody();
		const safePath = pathFilter(ctx, filePath);
		const lines = await readLines(safePath);
		const start = parseHash(start_tag, lines);
		const end = parseHash(end_tag, lines);
		if (start < 0 || end < 0) return ctx.send(400, { error: 'Tag not found' });
		if (start > end) return ctx.send(400, { error: 'start > end' });

		const replacedTags = newLines.map((line, i) => `${start + i + 1}#${shaHash(line)}`);
		lines.splice(start, end - start, ...newLines);
		lines.indices.splice(start, end - start, ...replacedTags);
		await fs.writeFile(safePath, lines.join('\n'), 'utf-8');
		ctx.send(200, { tags: replacedTags });
	});

	// 3. 写入文件（创建/覆写）
	router.post('write', async (ctx) => {
		const { path: filePath, lines } = await ctx.readBody();
		const safePath = pathFilter(ctx, filePath);
		await fs.mkdir(path.dirname(safePath), { recursive: true });
		await fs.writeFile(safePath, lines.join('\n'), 'utf-8');
		const tags = lines.map((line, i) => `${i + 1}#${shaHash(line)}`);
		// 更新缓存
		const cachedLines = [...lines];
		cachedLines.indices = tags;
		cache.set(filePath, new WeakRef(cachedLines));
		ctx.send(200, { tags });
	});

	// 4. 创建目录
	router.post('mkdir', async (ctx) => {
		const { path: filePath } = await ctx.readBody();
		await fs.mkdir(pathFilter(ctx, filePath), { recursive: true });
		ctx.send(200, { success: true });
	});

	// 5. 复制/移动
	router.post('copy', async (ctx) => {
		const { src, dest, move } = await ctx.readBody();
		const safeSrc = pathFilter(src);
		const safeDest = pathFilter(dest);
		if (move) {
			await fs.rename(safeSrc, safeDest);
		} else {
			await fs.cp(safeSrc, safeDest, { recursive: true });
		}
		ctx.send(200, { success: true });
	});

	// 6. 文件/目录信息
	router.post('stat', async (ctx) => {
		const { path: filePath } = await ctx.readBody();
		const stats = await fs.stat(pathFilter(ctx, filePath));
		ctx.send(200, {
			mode: stats.mode,
			size: stats.size,
			atime: Math.floor(stats.atimeMs / 1000),
			mtime: Math.floor(stats.mtimeMs / 1000),
			ctime: Math.floor(stats.ctimeMs / 1000),
			nlink: stats.nlink,
			is_dir: stats.isDirectory()
		});
	});

	// 7. 删除
	router.post('delete', async (ctx) => {
		const { path: filePath } = await ctx.readBody();
		const safePath = pathFilter(ctx, filePath);
		if (safePath === ctx.sandboxRoot) {
			return ctx.send(400, { error: 'Cannot delete root directory' });
		}
		await fs.rm(safePath, { recursive: true, force: true });
		cache.delete(filePath);
		ctx.send(200, { success: true });
	});

	// 8. 列表
	router.post('list', async (ctx) => {
		const { path: filePath, glob } = await ctx.readBody();
		const safePath = pathFilter(ctx, filePath);
		const entries = glob
			? await fs.glob(glob, { cwd: safePath, withFileTypes: true })
			: await fs.readdir(safePath, { withFileTypes: true });

		const items = [];
		let count = 0;
		const MAX_COUNT = 1000;
		for await (const entry of entries) {
			if (count >= MAX_COUNT) {
				items.push({ warning: `Too many files, truncated to ${count} items` });
				break;
			}
			count++;
			if (entry.isFile()) {
				const fullPath = path.join(safePath, entry.name);
				const stats = await fs.stat(fullPath);
				items.push({ name: entry.name, size: stats.size });
			} else {
				items.push({ name: entry.name, is_dir: true });
			}
		}
		ctx.send(200, items);
	});
}