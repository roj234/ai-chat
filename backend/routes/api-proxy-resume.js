import {SSE_RESUME_CACHE_SIZE, SSE_RESUME_TTL} from "../config.js";
import {LRUCache} from "../../common/LRUCache.js";
import fs from "node:fs/promises";
import {EventEmitter} from "node:events";
import {apiProxyLog as log} from "./api-proxy-utils.js";
import {ORIGINAL_ERROR} from "../../common/fetch-utils.js";

/**
 * @type {Map<string, AiChatBackend.SSEProxyRequest>}
 */
const activeRequests = new Map;
/**
 * @type {LRUCache<string, AiChatBackend.SSEProxyRequest>}
 */
export let finishedRequests;

export class ProxyResumeManager {
	start = Date.now();
	completion = {};
	/** @type {AiChatBackend.SSEProxyRequest} */
	req;
	abort = new AbortController;

	constructor(ctx, body, logPath) {
		this.ctx = ctx;
		this.body = body;
		this.logPath = logPath;
		this.startTime = Date.now();

		if (finishedRequests?.capacity !== SSE_RESUME_CACHE_SIZE) {
			finishedRequests = new LRUCache(SSE_RESUME_CACHE_SIZE, SSE_RESUME_TTL ? { ttlMode: "update" } : null);
		}
	}

	/**
	 * @param {string} id
	 * @return {{now: number, start: number}}
	 */
	begin(id) {
		log('响应开始', id);

		const now = Date.now();
		const req= this.req = {
			id,
			abort: this.abort,
			data: this.completion,
			event: new EventEmitter,
			isFinished: false
		};
		const {start, ctx, completion, logPath} = this;

		activeRequests.set(id, req);

		if (logPath) {
			const fileName = `${logPath}/${encodeURIComponent(id)}_${now%1000}.jsonl`;
			this._fileName = fileName;
			this._append = fs.mkdir(logPath, {recursive: true})
				.then(() => fs.appendFile(fileName, this.body))
				.catch(err => log('写入 trace 失败', err));
			this.body = null;
		}

		if (!ctx.res.headersSent)
			ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		return completion.resumable = { start, now };
	}

	/**
	 *
	 * @param {string} str
	 */
	send(str) {
		const {ctx, req} = this;

		if (ctx && !ctx.res.closed) ctx.res.write(`data: ${str}\n\n`);
		else this.ctx = null;

		req.lastUpdated = Date.now();
		req.event.emit('data', str);
	}

	/**
	 *
	 * @param {Error} err
	 */
	onError(err) {
		const {req, ctx} = this;

		const id = req?.id;
		if (err.name === 'AbortError') {
			log('请求中止', id);
		} else {
			if (err.message === "fetch failed") err = err.cause;

			log('请求出错', id, err);

			let {status = 500, [ORIGINAL_ERROR]: message} = err;

			if (message == null) message = err.message;
			const obj = message.error ? message : { error: message };

			if (req) {
				this.send(JSON.stringify(obj));
			} else {
				ctx.send(status, obj);
			}
			this.hasError = true;

			// 确保源连接被释放，避免 hang 住
			ctx.req.destroy();
		}
	}

	/**
	 *
	 * @param {boolean} [abort]
	 */
	end(abort) {
		const {req, completion, ctx, hasError} = this;

		if (req == null || abort) {
			this.abort.abort();
			if (req == null) return;
		}

		const id = req.id;

		completion.resumable.end = true;
		req.isFinished = true;
		req.event.emit('end');
		req.event.removeAllListeners();

		delete req.event;
		delete req.abort;
		this.req = null; // once

		activeRequests.delete(id);
		finishedRequests.set(id, req, SSE_RESUME_TTL);

		if (this._fileName) {
			this._append.then(() => fs.appendFile(this._fileName, JSON.stringify(req.data)), err => log('写入 trace 失败', err));
		}

		if (!hasError) {
			if (id) log('响应结束', id);
			if (ctx && !ctx.res.closed) ctx.res.end(`data: [DONE]\n\n`);
		}
	}
}

/**
 * @param {AiChatBackend.Router} router
 */
export function registerResumeRoutes(router) {
	finishedRequests = new LRUCache(SSE_RESUME_CACHE_SIZE, SSE_RESUME_TTL ? { ttlMode: "update" } : null);

	// 调试用
	router.get("/trace", (ctx) => {
		ctx.send(200, { generating: [...activeRequests.keys()], finished: [...finishedRequests.keys()] });
	});

	router.post('/resume/:id', (ctx) => {
		const {id} = ctx.params;
		const state = activeRequests.get(id) ?? finishedRequests.get(id);
		if (!state) return ctx.send(404, { error: "not found" });

		const {data, event, isFinished} = state;

		const res = ctx.res;
		if (!ctx.req.headers['accept']?.includes("text/event-stream")) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(data));
			return;
		}

		const onData = (text) => res.write(`data: ${text}\n\n`);
		const onEnd = () => res.end(`data: [DONE]\n\n`);

		// 如果是多线程，这里可能需要加锁，但是JS是谦让式协程，所以没什么好担心的
		if (!data.resumable.end) data.resumable.now = Date.now();

		res.writeHead(200, { 'Content-Type': 'text/event-stream' });
		onData(JSON.stringify(data));

		if (isFinished) { onEnd(); return; }

		event.on('data', onData);
		event.once('end', onEnd);

		res.on('close', () => event.off('data', onData));
	});
	router.post('/abort/:id', (ctx) => {
		const {id} = ctx.params;
		const state = activeRequests.get(id) ?? finishedRequests.get(id);

		if (state) {
			if (activeRequests.delete(id)) {
				state.abort.abort();
			} else {
				finishedRequests.delete(id);
			}
			return ctx.send(200, { success: true });
		}
		ctx.send(404, { error: "not found" });
	});
}