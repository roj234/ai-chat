import {fetch} from "@roj234/fetch-proxy";
import {createSocks5Agent} from "@roj234/fetch-proxy/agent/socks5";
import {LRUCache} from "@roj234/lru-cache";

globalThis.fetch = fetch;

const proxyCache = new LRUCache(100);

/**
 *
 * @param {string} proxyUrl
 * @return {undefined | ((string) => import("http").Agent)}
 */
export const getProxyAgent = (proxyUrl) => {
	if (!proxyUrl) return; // undefined
	let proxyAgent = proxyCache.get(proxyUrl);
	if (!proxyAgent) proxyCache.set(proxyUrl, proxyAgent = createSocks5Agent(proxyUrl));
	return proxyAgent;
}