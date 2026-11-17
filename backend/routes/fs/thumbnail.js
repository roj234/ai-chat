import {spawn, spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {DatabaseSync} from "node:sqlite";
import {cachePreparedSql} from "../../utils/sqliteUtils.js";

const PAGE_SIZE = 4096;
const WEBP_QUALITY = 50;

let sharp = null;
try {
    const mod = await import('sharp');
    const fn = mod?.default ?? mod;
    if (typeof fn === 'function') {
        void fn.versions;
        sharp = fn;
    }
} catch {
    sharp = null;
}

function detectFfmpeg() {
    try {
        const r = spawnSync('ffmpeg', ['-version'], {
            timeout: 3000,
            windowsHide: true,
            stdio: 'ignore',
        });
        return !r.error && r.status === 0;
    } catch {
        return false;
    }
}

const hasFfmpeg = detectFfmpeg();

export const thumbBackend = sharp ? 'sharp' : hasFfmpeg ? 'ffmpeg' : null;
export const isThumbAvailable = thumbBackend !== null;

/**
 *
 * @param {string | Buffer} input
 * @param {number} size
 * @return {Promise<Buffer>}
 */
async function viaSharp(input, size) {
    return sharp(input)
        .rotate() // 按 EXIF 方向摆正
        .resize({
            width: size,
            height: size,
            fit: 'inside', // 等比缩进 size×size 框内
            withoutEnlargement: true, // 小图不放大
        })
        .webp({ quality: WEBP_QUALITY, effort: 3 })
        .toBuffer();
}

/**
 *
 * @param {string[]} args
 * @param {Buffer} input
 * @return {Promise<Buffer>}
 */
function runFfmpeg(args, input) {
    return new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', args, { windowsHide: true });
        const chunks = [];
        let stderr = '';

        p.stdout.on('data', (c) => chunks.push(c));
        p.stderr.on('data', (c) => {
            stderr += c;
        });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
        });

        // 有 Buffer 输入就灌进 stdin；否则立刻关闭，避免管道挂起
        if (input) p.stdin.end(input);
        else p.stdin.end();
    });
}

/**
 *
 * @param {string | Buffer} input
 * @param {number} size
 * @return {Promise<Buffer>}
 */
async function viaFfmpeg(input, size) {
    const fromBuffer = Buffer.isBuffer(input);
    const args = ['-y', '-loglevel', 'error'];

    if (fromBuffer) {
        // 管道输入没有扩展名，靠 image2pipe 探测具体编码
        args.push('-f', 'image2pipe', '-i', 'pipe:0');
    } else {
        args.push('-nostdin', '-i', input);
    }

    args.push(
        // min(iw,size) / min(ih,size) 保证小图不被放大；逗号要转义
        '-vf',
        `scale=min(iw\\,${size}):min(ih\\,${size}):force_original_aspect_ratio=decrease`,
        '-frames:v', '1', // 只取一帧（防止 GIF 等被当序列处理）
        '-c:v', 'libwebp',
        '-quality', String(WEBP_QUALITY),
        '-compression_level', '4',
        '-f', 'webp',
        'pipe:1',
    );

    return runFfmpeg(args, fromBuffer ? input : undefined);
}

/* ------------------------------------------------------------------ */
/* 5. 对外主函数                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {string|Buffer} input   图片路径或 Buffer
 * @param {number} size    最长边像素（等比缩放）
 * @param {string} [output]  给了就写文件、返回 void；不给就返回 Buffer
 */
export async function generateThumb(
    input,
    size,
    output,
) {
    if (!isThumbAvailable) throw new Error('generateThumb: 没有可用的后端用于生成缩略图');

    const px = Math.max(1, Math.floor(size));

    let buf;
    if (thumbBackend === 'sharp') {
        try {
            buf = await viaSharp(input, px);
        } catch (err) {
            // sharp 处理失败（如不支持的格式），有 ffmpeg 就降级
            if (!hasFfmpeg) throw err;
            buf = await viaFfmpeg(input, px);
        }
    } else {
        buf = await viaFfmpeg(input, px);
    }

    if (output) {
        await writeFile(output, buf);
        return;
    }
    return buf;
}

export class ThumbnailManager {
    constructor({
        dbPath,
        maxBytes = 200 * 1024 * 1024, // 硬上限
        lowWaterRatio = 0.8,          // 淘汰到 80%
        size = 300,
        threads = 1,
     }) {
        this.maxBytes = maxBytes;
        this.lowWaterBytes = Math.floor(maxBytes * lowWaterRatio);
        this.size = size;
        this._threads = threads;

        this.db = new DatabaseSync(dbPath);
        this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA page_size = ${PAGE_SIZE};
      PRAGMA auto_vacuum = INCREMENTAL;
      PRAGMA cache_size = -65536;
    `);
        // 真正的磁盘硬顶：到顶 INSERT 会 SQLITE_FULL
        this.db.exec(`PRAGMA max_page_count = ${Math.floor(maxBytes / PAGE_SIZE)}`);

        this.db.exec(`
      CREATE TABLE IF NOT EXISTS thumbs (
        path      TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL,
        data      BLOB NOT NULL
      ) WITHOUT ROWID;

      CREATE INDEX IF NOT EXISTS thumbs_createdAt ON thumbs (createdAt);
    `);
        cachePreparedSql(this.db);

        this.totalBytes = this._sumBytes();
        this.inflight = new Map();

        this._ins  = this.db.prepare(`
      INSERT INTO thumbs (path, createdAt, data) VALUES (?, ?, ?)
      ON CONFLICT(path) DO UPDATE
        SET createdAt = excluded.createdAt, data = excluded.data
    `);
    }

    _sumBytes() {
        return this.db.prepare(
            'SELECT COALESCE(SUM(length(data)), 0) AS s FROM thumbs'
        ).get().s;
    }

    /**
     * @param {string} path
     * @return {Promise<Buffer>}
     */
    async getThumbnail(path) {
        const row = this.db.prepare('SELECT data FROM thumbs WHERE path = ?').get(path);
        if (row) return Buffer.from(row.data.buffer, row.data.byteOffset, row.data.byteLength);

        const taskId = this.size+'\0'+path;

        if (this.inflight.has(taskId)) return this.inflight.get(taskId);

        while (this.inflight.size >= this._threads)
            await Promise.race(this.inflight.values());

        const p = (async () => {
            try {
                const blob = await generateThumb(path, this.size);
                this._insert(path, blob);
                return blob;
            } finally {
                this.inflight.delete(taskId);
            }
        })();

        this.inflight.set(taskId, p);
        return p;
    }

    _insert(path, blob) {
        const size = blob.length;
        this._evict(size);

        const existing = this.db.prepare('SELECT length(data) AS s FROM thumbs WHERE path = ?').get(path);
        const old = existing ? existing.s : 0;

        try {
            this._ins.run(path, Date.now(), blob);
        } catch (e) {
            if (String(e).includes('SQLITE_FULL')) {
                // 估算偏保守/碎片导致，强制清到更低水位再试一次
                this._evict(size, this.maxBytes * 0.6);
                this._ins.run(path, Date.now(), blob);
            } else {
                throw e;
            }
        }

        this.totalBytes += size - old;
        this.db.exec('PRAGMA incremental_vacuum(200)');
    }

    _evict(incoming, lowWater = this.lowWaterBytes) {
        if (this.totalBytes + incoming <= this.maxBytes) return;

        const need = this.totalBytes + incoming - lowWater;
        if (need <= 0) return;

        this.db.prepare(`
      DELETE FROM thumbs WHERE path IN (
        WITH ordered AS (
          SELECT path,
                 SUM(length(data)) OVER (ORDER BY createdAt ASC, path ASC) AS cum
          FROM thumbs
        )
        SELECT path FROM ordered WHERE cum <= ?
      )
    `).run(need);

        this.totalBytes = this._sumBytes();
    }

    close() {
        this.db.close();
    }
}