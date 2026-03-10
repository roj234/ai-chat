import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'crypto';

const execFilePromise = promisify(execFile);
export const ROOT_DIR = path.resolve(process.env.APP_ROOT_DIR || './data');

// 安全工具：路径校验
function pathFilter(relPath) {
    if (fileIndex.has(relPath)) return fileIndex.get(relPath);

    const targetPath = path.resolve(ROOT_DIR, relPath.replace(/^\/+/, ''));

    if (!targetPath.startsWith(ROOT_DIR)) {
        const err = new Error("Forbidden: Path Traversal");
        err.statusCode = 403;
        throw err;
    }
    return targetPath;
}

function shaHash(content, len = 4) {
    return crypto.createHash('sha-1').update(content).digest('hex').substring(0, len).toUpperCase();
}

function parseHash(hash, lines) {
    if (hash === "#END") return lines.length;
    const idx = hash.indexOf("#");
    const lineNo = parseInt(hash.substring(0, idx)) - 1;
    const line = lines[lineNo];
    if (line && shaHash(line) === hash.substring(idx+1)) return lineNo;
    return lines.indices.indexOf(hash);
}

/**
 *
 * @type {Map<string, WeakRef<string[]>>}
 */
const cache = new Map;

/**
 *
 * @type {Map<string, string>}
 */
const fileIndex = new Map;

/**
 *
 * @param {string} path
 * @return {Promise<string[]>}
 */
async function readLines(path) {
    const {mtime} = await fs.stat(path);
    let lines = cache.get(path)?.deref();
    if (!lines || lines.mtime < mtime) {
        const content = await fs.readFile(path, 'utf-8');
        lines = content.split(/\r?\n/);
        lines.indices = lines.map((line, index) => `${index + 1}#${shaHash(line)}`);
        lines.mtime = Date.now();
        cache.set(path, new WeakRef(lines));
    }
    return lines;
}

export default async function({ path: url, query_parameter, post_data }) {
    switch (url) {
        case "read": {
            const { path, begin, end, max_chars = 10000 } = post_data;
            const safePath = pathFilter(path);

            const stats = await fs.stat(safePath);
            if (stats.size > 10485760) return { error: "File is too big ("+stats.size+" bytes)" }

            const ext = safePath.substring(safePath.lastIndexOf('.') + 1).toLowerCase();
            if (ext === "png" || ext === "jpg" || ext === "bmp" || ext === "jpeg") {
                return {
                    _data: await fs.readFile(safePath),
                    _mime: 'image/' + ext,
                };
            }

            const lines = await readLines(safePath);
            const start = begin ? begin - 1 : 0;
            const stop = end ? Math.min(end, lines.length) : lines.length;

            let limit = max_chars;
            let truncated = 0;

            const indices = lines.indices;
            const resp_lines = [];
            for (let index = start; index < stop; index ++) {
                const line = lines[index];

                if (limit <= line.length) {
                    truncated = stop - index;
                    break;
                }
                limit -= line.length;

                resp_lines.push(indices[index]+`| ${line}`);
            }

            let content = truncated ? `Warning: max_chars reached, truncated ${truncated} lines\n` : '';
            content += `Total lines: ${lines.length}\nReturned lines: ${resp_lines.length}\n\nLine#Tag| Content\n${resp_lines.join('\n')}`;
            return {
                _data: content,
                _mime: "text/plain"
            };
        }

        case "replace": {
            const { path: path1, start_tag, end_tag, lines: new_lines } = post_data;
            const safePath = pathFilter(path1);
            const lines = await readLines(safePath);

            const start = parseHash(start_tag, lines), end = parseHash(end_tag, lines);
            if (start < 0 || end < 0) return { error: "Tag not found" };
            if (start > end) return { error: "start > end" };

            //throw new Error("Search string not found");

            const replaced_tags = new_lines.map((line, index) => {
                return `${start + index + 1}#${shaHash(line)}`;
            })
            lines.splice(start, end - start, ...new_lines);
            lines.indices.splice(start, end - start, ...replaced_tags);

            await fs.writeFile(safePath, lines.join('\n'), 'utf-8');
            return { tags: replaced_tags };
        }

        case "write": {
            const { path: path1, lines } = post_data;
            const safePath = pathFilter(path1);
            await fs.mkdir(path.dirname(safePath), { recursive: true });
            await fs.writeFile(safePath, lines.join('\n'), 'utf-8');

            const tags = lines.map((line, index) => {
                return `${index + 1}#${shaHash(line)}`;
            })
            lines.indices = tags;
            cache.set(path, new WeakRef(lines));

            return { tags };
        }

        case "mkdir": {
            const safePath = pathFilter(post_data.path);
            await fs.mkdir(safePath, { recursive: true });
            return "success";
        }

        case "copy": {
            const src = pathFilter(post_data.src);
            const dest = pathFilter(post_data.dest);
            if (post_data.move) {
                await fs.rename(src, dest);
            } else {
                await fs.cp(src, dest, { recursive: true });
            }
            return "success";
        }

        case "stat": {
            const stats = await fs.stat(pathFilter(post_data.path));
            return {
                mode: stats.mode,
                size: stats.size,
                atime: parseInt(stats.atimeMs / 1000),
                mtime: parseInt(stats.mtimeMs / 1000),
                ctime: parseInt(stats.ctimeMs / 1000),
                nlink: stats.nlink,
                is_dir: stats.isDirectory()
            };
        }

        case "delete": {
            const safePath = pathFilter(post_data.path);
            if (safePath === ROOT_DIR) {
                throw new Error("Cannot delete root directory");
            }
            await fs.rm(safePath, { recursive: true, force: true });
            cache.delete(path);
            return "success";
        }

        case "list": {
            const safePath = pathFilter(post_data.path);
            const entries = post_data.glob ? fs.glob(post_data.glob, {
                cwd: safePath,
                withFileTypes: true
            }) : await fs.readdir(safePath, { withFileTypes: true });

            const items = [];
            let count = 0;
            const MAX_COUNT = 1000;

            for await (const entry of entries) {
                if (count >= MAX_COUNT) {
                    items.push({
                        warning: "Too many files, truncated to "+count+" items"
                    })
                    break;
                }
                count++;

                if (entry.isFile()) {
                    const fullPath = path.join(safePath, entry.name);
                    const stats = await fs.stat(fullPath);
                    items.push({
                        name: entry.name,
                        size: stats.size
                    });
                } else {
                    items.push({
                        name: entry.name,
                        is_dir: true
                    });
                }
            }

            return items;
        }

        case "spawn": {
            const { program, arguments: args, directory, timeout = 10 } = post_data;
            const safeCwd = pathFilter(directory);
            const { stdout, stderr, code } = await execFilePromise(program, args, {
                cwd: safeCwd,
                timeout: timeout * 1000
            }).catch(err => {
                // 处理执行失败的情况（如返回码非0）
                return { code: err.code, stdout: err.stdout, stderr: err.stderr };
            });
            return { code, stdout, stderr };
        }
    }
}