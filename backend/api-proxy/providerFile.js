import fs from "node:fs";
import {createJsonParser} from "unconscious/common/Json.js";

/**
 * @param {string} filePath
 * @returns {Record<string, AiChatBackend.SSEProxyTarget>}
 */
export function parseProviderFile(filePath) {
	const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
	const lines = content.split(/\r?\n/);

	const providers = new Map();
	const result = Object.create(null);

	function addKey(keyName, value, lineNumber) {
		if (keyName in result) {
			console.warn(`警告：key-name 重复 "${keyName}"，第 ${lineNumber} 行将覆盖之前的值`);
		}

		result[keyName] = value;
	}

	for (let ln = 0; ln < lines.length;) {
		const line = lines[ln++].trim();
		if (!line || line.startsWith('#')) continue;

		if (line.startsWith("provider ")) {
			const j = line.indexOf(" ", 9);
			const providerName = line.slice(9, j);
			if (providers.has(providerName)) throw new Error(`第 ${ln} 行 provider 名称重复`);

			const parser = createJsonParser(() => {}, { json5: true });

			let providerObj;
			try {
				parser.write(line.slice(j+1));

				for (;ln < lines.length; ln++) {
					try {
						parser.write(lines[ln]);
					} catch (e) {
						break;
					}
				}

				providerObj = parser.end();
			} catch (err) {
				throw new Error(`第 ${ln} 行 provider 解析失败: ${err.message}`);
			}

			providers.set(providerName, providerObj);
			continue;
		}

		if (/^https?:\/\//i.test(line)) {
			const inlineMatch = line.match(/^(https?:\/\/\S+)\s+(\S+)\s+(.+)$/);
			if (!inlineMatch) throw new Error(`第 ${ln} 行内联提供商格式错误: ${line}`);

			const [, url, keyName, key] = inlineMatch;
			addKey(
				keyName,
				{
					url,
					authorization: key,
				},
				ln
			);
			continue;
		}

		const normalMatch = line.match(/^(\S+)\s+(\S+)\s+(.+)$/);
		if (!normalMatch) throw new Error(`第 ${ln} 行格式错误: ${line}`);

		const [, providerName, keyName, key] = normalMatch;

		if (!providers.has(providerName)) throw new Error(`第 ${ln} 行使用了未定义的 provider: ${providerName}`);

		const providerObj = providers.get(providerName);
		addKey(
			keyName,
			{
				...providerObj,
				authorization: key,
			},
			ln
		);
	}

	return result;
}