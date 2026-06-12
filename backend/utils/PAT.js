import {bakeSchema, decodeRawMsg, encodeRawMsg} from "unconscious/common/msgpack.js";
import {createHmac, timingSafeEqual} from 'node:crypto';
import {PAT_SERVER_SALT, PAT_VALID_AFTER} from "../config.js";
import {compressGeneric} from "./compression.js";

const pat_schema = [
	"created",
	"validUntil",
	"region",
	"capabilities",
];

bakeSchema(pat_schema);

/**
 * @typedef {{
 *     created: number,
 *     validUntil?: number,
 *     region?: string,
 *     capabilities: number
 * }} PAT
 */

/**
 *
 * @param {string} authorization
 * @param {AiChatBackend.RouteContext} ctx
 * @return {boolean}
 */
export const checkPAT = (authorization, ctx) => {
	if (authorization.length < 20 || authorization.length > 384) return false;
	const userSalt = ctx.db.prepare("SELECT value from kv WHERE key = 'salt'").get();
	if (!userSalt) return false;

	try {
		const buffer = Buffer.from(authorization, 'base64url');
		const [
			/** @type {PAT} */
			pat,
			endOffset
		] = decodeRawMsg(new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), 0, {schema: pat_schema});

		const hmac = createHmac('sha256', PAT_SERVER_SALT);
		hmac.update(userSalt.value);
		hmac.update(buffer.subarray(0, endOffset));

		const signature = hmac.digest().subarray(0, 16);
		const signature2 = buffer.subarray(endOffset);

		if (!timingSafeEqual(signature, signature2)) return false;

		const {created, validUntil, region, capabilities} = pat;

		const time = parseInt(Date.now() / 1000);
		if (created > time || created < PAT_VALID_AFTER) return false;
		if (validUntil != null && time > validUntil) return false;

		const remoteAddress = ctx.req.socket.remoteAddress;
		// 未实现

	} catch (e) {
		console.error('PAT '+JSON.stringify(authorization.slice(0, 64)+"...")+" verify failed", e);
		return false;
	}

	return true;
}

/**
 *
 * @param {AiChatBackend.RouteContext} ctx
 * @param {number} capabilities
 * @return {string}
 */
export const generatePAT = (ctx, capabilities = 0) => {
	let salt;
	const row = ctx.db.prepare("SELECT value from kv WHERE key = 'salt'").get();
	if (!row) ctx.db.prepare("INSERT INTO kv (key, value) VALUES ('salt', ?)").run(salt = compressGeneric(crypto.getRandomValues(new Uint8Array(16))));
	else salt = row.value;

	const buffer = Buffer.allocUnsafe(256);
	let off = 0;

	/** @type {PAT} */
	const pat = {
		// created 拿来当 salt
		created: parseInt(Date.now() / 1000),
		capabilities
	};
	encodeRawMsg(pat, (array) => {
		buffer.set(array, off);
		off += array.length;
	}, pat_schema);

	const hmac = createHmac('sha256', PAT_SERVER_SALT);

	hmac.update(salt);
	hmac.update(buffer.subarray(0, off));

	const signature = hmac.digest().subarray(0, 16);
	buffer.set(signature, off);
	off += 16;

	return buffer.subarray(0, off).toString('base64url');
};