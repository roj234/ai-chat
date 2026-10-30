import {getRPMLimit} from "./rate-limiter.js";
import {TOKENS} from "./api-proxy-openai.js";
import {apiProxyLog} from "./api-proxy-utils.js";

const HOSTNAME_CACHE = Symbol();

/**
 * @param {string} url
 * @returns {string}
 */
const safeHostname = (url) => {
	try {
		return new URL(url).hostname;
	} catch {
		return String(url);
	}
};

const defaultBodyHandler = (body, provider) => {
	if (body.stream) {
		Object.assign(body, {
			stream_options: { include_usage: true }
		});
	}
	if (provider.url.includes("api.minimaxi.com")) {
		body.reasoning_split = true;
	}
};

const defaultFatalPattern = /insufficient|not (?:exist|found|activated)|access[ _]?denied|invalid[ _](?:api[ _])?key|quota exhausted/i;

/**
 * @param {Record<string, {
 *     models?: string[],
 *     tpm?: number,
 *     rpm?: number
 * }>} API_KEYS
 * @param {Record<string, Partial<AiChatBackend.SSEProxyTarget>[]>} PROVIDER_MAPPING
 * @param {RegExp} [FATAL_PATTERNS]
 * @param {function(OpenAI.ChatCompletionRequest, AiChatBackend.SSEProxyTarget, AiChatBackend.RouteContext): true | void} [bodyHandler]
 * @return {AiChatBackend.ModerationHandler}
 */
export const advancedLLMProxy = (API_KEYS, PROVIDER_MAPPING, FATAL_PATTERNS = defaultFatalPattern, bodyHandler = defaultBodyHandler) => {
	//const tsdb = TSDB.create("llm-api");

	const allModels = Object.keys(PROVIDER_MAPPING);
	for (const item of Object.values(API_KEYS)) {
		if (!item.models) item.models = allModels;
	}

	return async (target, ctx) => {
		const zzzKeyInfo = API_KEYS[target.authorization];
		if (!zzzKeyInfo) return;

		const rpm = zzzKeyInfo.rpm;
		const tpm = zzzKeyInfo.tpm;
		let limiter, state;
		if (rpm || tpm) {
			limiter = getRPMLimit(zzzKeyInfo);
			if (!(state = limiter.rpm(rpm ?? 1000))) {
				return ctx.send(429, { error: { message: 'RPM limit exceeded. Retry later.', type: 'rate_limit_error' } });
			}
		}

		let obj;

		return [(req, target) => {
			const requestedModel = req.model;
			if (!requestedModel) return ctx.send(400, { error: { message: 'Missing "model" field', type: 'invalid_request_error' } });

			const modelLimit = zzzKeyInfo.models;
			const providers = PROVIDER_MAPPING[requestedModel];
			if (!providers || (modelLimit && !modelLimit.includes(requestedModel))) return ctx.send(404, { error: { message: `Model "${requestedModel}" not found`, type: 'invalid_request_error' } });

			let provider = providers.find(s => s.enabled !== false);
			if (!provider) return ctx.send(503, { error: { message: `Model "${requestedModel}" has no available providers`, type: 'proxy_error' } });

			const predictTokens = req[TOKENS] / 4;

			if (limiter && !limiter.tpm(tpm, state, predictTokens)) {
				return ctx.send(429, { error: { message: 'TPM limit exceeded. Retry later.', type: 'rate_limit_error' } });
			}

			const modelOverride = provider.model;
			if (modelOverride != null) req.model = modelOverride;

			if (bodyHandler(req, provider, ctx)) return;

			apiProxyLog(`${zzzKeyInfo.name ?? target.authorization.slice(0, 6) + "..."}:${requestedModel} => ${provider[HOSTNAME_CACHE] ??= safeHostname(provider.url)}:${modelOverride ?? requestedModel} (${provider.name ?? provider.authorization.slice(0, 6) + "..."})`)
			obj = provider;
			return provider;
		}, err => {
			const message = err.message;
			if (message && obj && FATAL_PATTERNS?.test(message)) {
				obj.enabled = false;
				obj.authorization = obj.authorization.slice(0, 6) + "...";
				apiProxyLog(
					`Key 已禁用`,
					obj,
					message
				);
			}
		}, completion => {
			const usage = completion.usage;
			if (limiter && usage) {
				const tokens = usage.total_tokens - (usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0);
				if (isFinite(tokens)) limiter.tpm(Infinity, state, tokens);
			}
		}]
	}
}
