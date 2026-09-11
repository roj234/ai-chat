import {createHash} from "node:crypto";

const locks = new Map;

/**
 * @template {function(AiChatBackend.RouteContext): Promise<*>} T
 * @param {T} func
 * @param {boolean} [wait]
 * @return {T}
 */
export const exclusiveLock = (func, wait) => {
	const funcHash = createHash("sha-256").update(func.toString()).digest().toString("base64url");
	return async (...args) => {
		const ctx = args.at(-1);
		const lockKey = ctx.params.userId+":"+funcHash;
		if (locks.has(lockKey)) {
			if (!wait) return ctx.send(429, { error: "This interface is in transaction." });

			let onClosed;
			const closeCallback = new Promise(resolve => onClosed = resolve);
			ctx.res.once('close', onClosed);

			let closed;
			do {
				// 注意，这类似 Java 的 wait() 和 notifyAll()。务必二次检查条件
				await Promise.race([locks.get(lockKey), closeCallback]).catch(() => {});

				// 首先确认一下是哪个到期了
				closed = ctx.res.closed;
				if (closed) break;

			} while (locks.has(lockKey));

			ctx.res.off('close', onClosed);
			if (closed) return;
		}

		const p = func.apply(null, args);
		locks.set(lockKey, p);
		p.finally(() => locks.delete(lockKey));
		return p;
	}
}
