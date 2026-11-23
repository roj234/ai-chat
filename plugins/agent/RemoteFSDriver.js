import SimpleModal from "/src/components/SimpleModal.jsx";
import {connectBestServer, prettyError} from "/src/utils/utils.js";
import {kvListSet} from "/src/database.js";
import {ContentPart} from "/src/toolset.js";
import {$computed, $state, unconscious} from "unconscious";
import {FSE_NotFound, throwDOMException} from "/common/pure-utils.js";

export const BACKEND_SERVER_KVLIST_ID = "fs_backend_uri";

export const addRemoteFileSystem = (prevData = { servers: [''] }) => new Promise((resolve, reject) => {
	const connect = $state();
	SimpleModal({
		title: "🐳 缚印 (专用文件服务)",
		after: $computed(() => unconscious(connect) ? <div className={"input-warning"}>{connect}</div> : null),
		type: "filter",
		value: [
			{
				id: "name",
				type: "input",
				name: "名称 (slug)",
				required: true,
				placeholder: "不能重复 (重复将替换)"
			},
			{
				type: "list",
				name: "服务器地址",
				title: "连接延迟最低的服务器（绕开NAT回环）",
				placeholder: "http://example.lan:3001/api",
				id: "servers",
				pattern: /^https?:\/\/.+/,
				warning: "请输入正确的网址",
				required: true
			},
			{
				type: "secret",
				name: "个人访问密钥 (PAT)",
				placeholder: "sk-xxxxxx",
				id: "pat",
			},
		],
		placeholder: prevData,
		confirmMessage: "连接",
		onFilterChanged() { connect.value = null; },
		onConfirm: async ({name, servers, pat}) => {
			if (servers.length < 1) return false;

			try {
				await connectBestServer(servers, pat, 'fs');
			} catch (e) {
				connect.value = prettyError(e);
				return false;
			}

			const def = {
				type: BACKEND_SERVER_KVLIST_ID,
				name: name || servers[0],
				servers,
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
 * @param {Set<String>} cap
 * @return {Promise<AiChat.FileSystemInstance>}
 */
export const createRemoteFileSystem = (baseUrl, pat, fileBase, cap) =>
	/**
	 * @param {string} func
	 * @param {Record<string, string>} parameters
	 * @returns {Promise<any|Blob|ContentPart|string>}
	 */
	async (func, parameters) => {
		let endpoint = baseUrl + func;

		if (fileBase) endpoint += '?root='+encodeURIComponent(fileBase);

		// ── Binary write / append: send raw Uint8Array body ──
		let body, headers = {
			authorization: 'Bearer ' + pat,
			accept: "application/json,*/*"
		};

		if (func === 'getUrl') {
			return {
				base: baseUrl,
				root: fileBase,
				headers
			};
		}

		let method, stream, signal;
		if ((func === 'thumb' || func.endsWith("Raw")) && parameters) {
			// Append extra params as query string
			const sep = endpoint.includes('?') ? '&' : '?';

			const {content, stream: s1, signal: s2, metaOnly, offset, ...rest} = parameters;
			body = content;
			stream = s1;
			if (metaOnly) method = "HEAD";
			if (offset) headers['Range'] = `bytes=${parameters.offset}-`;
			signal = s2;

			endpoint += sep + new URLSearchParams(Object.entries(rest));

			if (body) headers['Content-Type'] = 'application/octet-stream';
			else parameters = null;
		} else if (parameters) {
			body = JSON.stringify(parameters);
			if (body === '{}') body = parameters = null;
			else headers['Content-Type'] = 'application/json';
		}

		let response;
		try {
			response = await fetch(endpoint, {
				method: method ?? (parameters ? 'POST' : 'GET'),
				headers,
				body,
				signal
			});
		} catch (e) {
			throw "FileService dead";
		}

		const mime = response.headers.get("content-type") || "";
		const status = response.status;

		if (method === 'HEAD') {
			await response.body?.cancel();
			if (status === 404) throwDOMException("文件不存在", FSE_NotFound);
			return {
				lastModified: Date.parse(response.headers.get('last-modified')),
				// 反向代理比如 nginx 启用 gzip 会把这个抹了
				size: parseInt(response.headers.get('content-length')) || 0,
			}
		}

		if (!response.ok) {
			if (status === 502)
				throw "FileService dead";

			if (mime.includes("application/json")) {
				if (status === 404 && response.headers.get("content-length") === "0") {
					throw `${func} is not implemented in this VFS`;
				}
				throw (await response.json()).error;
			}
			throw (await response.text());
		}

		if (mime === "application/octet-stream" || func === 'readRaw' || func === 'thumb') return stream ? response : await response.blob();
		if (mime.startsWith("image/")) return new ContentPart().image(await response.blob());
		if (mime.includes("application/json")) return await response.json();
		return await response.text() || "Success";
	};
