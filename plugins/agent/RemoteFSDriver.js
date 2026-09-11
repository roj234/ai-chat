import SimpleModal from "/src/components/SimpleModal.jsx";
import {connectBestServer, prettyError} from "/src/utils/utils.js";
import {kvListSet} from "/src/database.js";
import {ContentPart} from "/src/toolset.js";
import {$computed, $state, unconscious} from "unconscious";

export const BACKEND_SERVER_KVLIST_ID = "fs_backend_uri";

export const addRemoteFileSystem = (prevData = { servers: [''] }) => new Promise((resolve, reject) => {
	const connect = $state();
	SimpleModal({
		title: "🐳 缚印 (专用文件服务)",
		message: <><a href="./docs.html#documents/build.md:部署" target="_blank">说明</a></>,
		after: $computed(() => unconscious(connect) ? <div className={"input-warning"}>{connect}</div> : null),
		type: "filter",
		value: [
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
				type: "input",
				name: "个人访问密钥 (PAT)",
				placeholder: "sk-xxxxxx",
				id: "pat",
			},
			{
				id: "name",
				type: "input",
				name: "名称 (slug)",
				placeholder: "不能重复 默认用第一个服务器的地址"
			},
		],
		placeholder: prevData,
		confirmMessage: "连接",
		onFilterChanged() { connect.value = null; },
		onConfirm: async ({name, servers, pat}) => {
			if (servers.length < 1) return false;

			let _, instanceId;
			try {
				[_, instanceId] = await connectBestServer(servers, '', 'fs');
			} catch (e) {
				connect.value = prettyError(e);
				return false;
			}

			const def = {
				type: BACKEND_SERVER_KVLIST_ID,
				name: name || servers[0],
				servers,
				instanceId,
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
export const createRemoteFileSystem = (baseUrl, pat, fileBase) =>
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
			if (body === '{}') body = parameters = null;
			else headers['Content-Type'] = 'application/json';
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
	};
