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
		const name = ctx.params.userId + ":" +funcHash;
		if (locks.has(name)) {
			if (!wait) return ctx.send(429, { error: "This interface is in transaction." });

			let _resolve;
			const promise = new Promise(resolve => _resolve = resolve);
			ctx.res.once('close', _resolve);

			await Promise.race([locks.get(name), promise]).catch(() => {});

			ctx.res.off('close', _resolve);
			if (ctx.res.closed) return;
		}

		const p = func.apply(null, args);
		locks.set(name, p);
		p.finally(() => locks.delete(name));
		return p;
	}
}
