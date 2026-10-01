import {jsonFetch} from "/common/fetch-utils.js";
import SimpleModal from "/src/components/SimpleModal.jsx";
import {prettyError} from "/src/utils/utils.js";
import {kvListSet} from "/src/database.js";
import {ContentPart} from "/src/toolset.js";
import {$computed, $state, unconscious} from "unconscious";
import {SHA256} from "unconscious/common/SHA256.js";

export const BACKEND_SERVER_KVLIST_ID = "fs_backend_uri";

const MSG = "文件服务响应异常，请确认 URL 是否配置正确。";

/**
 *
 * @param {string} baseUrl
 * @param {string} pat
 * @returns {Promise<void>}
 */
const connectServer = async (baseUrl, pat) => {
	const nonce = crypto.randomUUID();
	const exceptResult = new SHA256().update(nonce+'AiChat').toString();

	let json;
	try {
		json = await jsonFetch(baseUrl+"ping", {
			key: pat,
			body: JSON.stringify({nonce})
		});
	} catch (e) {
		throw MSG+"\n原始错误信息: "+e;
	}
	if (json.pong !== exceptResult) throw MSG;
};

export const addRemoteFileSystem = () => new Promise((resolve, reject) => {
	const connect = $state();
	SimpleModal({
		title: "🐳 缚印 (专用文件服务)",
		message: <><a href={"./docs.html#documents/build.md:部署"}>查看文档</a>获取使用说明！</>,
		after: $computed(() => unconscious(connect) ? <div className={"input-warning"}>{connect}</div> : null),
		type: "filter",
		value: [
			{
				type: "input",
				name: "地址",
				placeholder: "http://example.lan:3003/api/",
				id: "uri",
				pattern: /^https?:\/\/.+/,
				warning: "请输入正确的网址",
				required: true
			},
			{
				type: "input",
				name: "个人访问密钥 (PAT)",
				placeholder: "sk-xxxxxx",
				id: "pat",
			},
		],
		confirmMessage: "连接",
		onFilterChanged() { connect.value = null; },
		onConfirm: async ({uri, pat}) => {
			if (!uri.endsWith('/')) uri += '/';

			try {
				await connectServer(uri+"fs/", pat);
			} catch (e) {
				connect.value = prettyError(e);
				return false;
			}

			const def = {
				type: BACKEND_SERVER_KVLIST_ID,
				name: uri,
				uri: uri,
				pat,
				lastAccessed: Date.now()
			};

			kvListSet(def, BACKEND_SERVER_KVLIST_ID).then(() => resolve(def), reject);
		},
		onCancel: reject
	});
});

/**
 *
 * @param {string} baseUrl
 * @param {string} pat
 * @param {string=} fileBase
 * @return {Promise<AiChat.FileSystemInstance>}
 */
export const createRemoteFileSystem = (baseUrl, pat, fileBase) => connectServer(baseUrl, pat).then(() =>
	/**
	 * @param {string} func
	 * @param {Record<string, string>} parameters
	 * @returns {Promise<any|Blob|ContentPart|string>}
	 */
	async (func, parameters) => {
		let endpoint = baseUrl + func;

		if (fileBase) endpoint += '?root=' + encodeURIComponent(fileBase);

		// ── Binary write / append: send raw Uint8Array body ──
		const isBinaryWrite = func === 'writeRaw' || func === 'appendRaw';
		let body, headers = {
			Authorization: 'Bearer ' + pat
		};
		if (isBinaryWrite && parameters) {
			// Append extra params as query string
			const sep = endpoint.includes('?') ? '&' : '?';
			endpoint += sep + 'path=' + encodeURIComponent(parameters.path);
			body = parameters.content;
			headers['Content-Type'] = 'application/octet-stream';
		} else if (parameters) {
			body = JSON.stringify(parameters);
			headers['Content-Type'] = 'application/json';
		}

		let response;
		try {
			response = await fetch(endpoint, {
				method: parameters ? 'POST' : 'GET',
				headers,
				body,
			});
		} catch (e) {
			throw "FileService dead";
		}

		const content = response.headers.get("content-type") || "";

		if (!response.ok) {
			if (response.status === 404) {
				throw `${func} is not implemented in this VFS`;
			}

			if (content.includes("application/json")) throw (await response.json()).error;
			throw (await response.text());
		}

		if (content.startsWith("image/")) return new ContentPart().image(await response.blob());
		if (content === "application/octet-stream") return await response.blob();
		if (content.includes("application/json")) return await response.json();
		return await response.text();
	});
