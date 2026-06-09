import {$store} from "unconscious";

/**
 * @typedef {{
 *         hasUpdate: boolean,
 *         latestVersion: number,
 *         releaseNote: string,
 *         releaseUrl: string,
 *         publishedAt: string
 * }} UpdateInfo
 */

/**
 *
 * @type {import("unconscious").Reactive<{
 *     time: number,
 *     retryAfter: number,
 *     info: UpdateInfo
 * }>}
 */
const updateInfo = $store("update", {}, {persist: true, deep: false});

/**
 *
 * @param {boolean=} force 预留？
 * @return {Promise<UpdateInfo>}
 */
export async function checkUpdate(force) {
	const lastCheckTime = updateInfo.time;
	const time = Date.now();
	const canCheck = time > (updateInfo.retryAfter || 0) && time - lastCheckTime > 4000000;

	let info = updateInfo.info;
	if (!canCheck && info) return info;

	const url = `https://api.github.com/repos/roj234/ai-chat/releases/latest`;
	const response = await fetch(url, { headers: {
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
		}
	});

	if (response.status === 403) {
		const remaining = response.headers.get('x-ratelimit-remaining');
		if (remaining === '0') {
			const after = parseInt(response.headers.get("x-ratelimit-reset")) * 1000;
			updateInfo.retryAfter = after;
			return new Promise((resolve) => setTimeout(() => resolve(checkUpdate(force)), after - Date.now()));
		}
	}

	if (!response.ok) throw new Error(`请求失败: ${response.status} ${response.statusText}`);

	const release = await response.json();

	const author = release.author;
	if (author.type !== "Bot" || author.login !== "github-actions[bot]")
		throw new Error("版本发布者不可信");

	const message = release.body;
	const latestVersion = parseInt(release.tag_name.replace(/^v/, ''));
	let hasUpdate = BUILD_NUMBER < latestVersion;

	info = {
		hasUpdate,
		releaseNote: message,
		latestVersion,
		releaseUrl: release.html_url,
		publishedAt: release.published_at,
	};

	updateInfo.value = {
		time,
		info
	}

	return info;
}
