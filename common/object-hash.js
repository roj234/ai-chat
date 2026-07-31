import {SHA256} from "unconscious/common/SHA256.js";
import {encodeRawMsg} from "unconscious/common/msgpack.js";
import {encodeObjects} from "../src/utils/marshal.js";
import {base64Encode} from "unconscious/common/Base64.js";

/**
 * @param {Object} obj
 * @returns {Promise<string>}
 */
export const objectIdentityHash = async obj => {
	const mapping = new Map;
	await encodeObjects(obj, mapping);
	const hasher = new SHA256();
	encodeRawMsg(obj, (data) => hasher.update(data), {
		sortKeys: true,
		replacer: mapping.size ? (value) => mapping.get(value) ?? value : null
	});
	return base64Encode(new Uint8Array(hasher.digest()), true);
};