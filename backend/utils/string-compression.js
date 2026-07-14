import {base64Encode, createBase64Decoder} from "unconscious/common/Base64.js";

const BASE64 = 0;
const BASE64URL = 1;
const BASE64PAD = 2;
const BASE64URLPAD = 3;
const HEX = 4;
const UUID = 5;
const HEX_UPPER = 6;
const UUID_UPPER = 7;

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HEX_RUN = /[0-9a-fA-F]/;
const BASE64_CHAR = /[A-Za-z0-9_\-+\/=]/;

function hexToBytes(flag, hex) {
	const bytes = new Uint8Array(1 + hex.length / 2);
	bytes[0] = flag;
	for (let i = 0; i < hex.length; i += 2) {
		bytes[1 + i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

function bytesToHex(bytes) {
	let result = "";
	for (const byte of bytes) {
		result += byte.toString(16).padStart(2, "0");
	}
	return result;
}

function findDictionaryToken(input, position, dictionary) {
	let best = null;

	for (let index = 0; index < dictionary.length; index += 1) {
		const entry = dictionary[index];
		if (!input.startsWith(entry, position)) continue;

		if (
			best == null ||
			entry.length > best.text.length ||
			(entry.length === best.text.length && index < best.index)
		) {
			best = { index, text: entry };
		}
	}

	return best?.index;
}

function findUuidToken(input, position) {
	const value = input.slice(position, position + 36);
	if (!UUID_SHAPE.test(value)) return null;

	if (value === value.toLowerCase()) return hexToBytes(UUID, value.replaceAll("-", ""));
	if (value === value.toUpperCase()) return hexToBytes(UUID, value.replaceAll("-", ""));

	// A mixed-case UUID cannot be reconstructed from bytes alone, so retain it
	// as literal text instead of silently changing its casing during expansion.
	return { mixedCase: true };
}

function findHexToken(input, position) {
	if (position > 0 && HEX_RUN.test(input[position - 1])) return null;

	let end = position;
	while (end < input.length && HEX_RUN.test(input[end])) end += 1;

	let len = end - position;
	if (len&1) len--;
	if (len <= 6) return null;

	const value = input.slice(position, end);
	if (value === value.toLowerCase()) return hexToBytes(HEX, value);
	if (value === value.toUpperCase()) return hexToBytes(HEX_UPPER, value);

	// As with UUIDs, preserving mixed casing would require extra metadata.
	return null;
}

function hasBase64Shape(value) {
	if (value.length <= 8 || value.length % 4 === 1) return;

	// Base64's alphabet overlaps heavily with ordinary text. These conservative
	// signals avoid converting common words such as "hello" while still finding
	// the usual encoded values and URL-safe '-'/'_' values.
	const hasUrlSafeMarker = /[-_]/.test(value);
	const hasGeneralMarker = /[+\/]/.test(value);

	if (hasGeneralMarker && hasUrlSafeMarker) return;

	const hasUpper = /[A-Z]/.test(value);
	const hasLower = /[a-z]/.test(value);
	const hasDigit = /[0-9]/.test(value);
	if (((hasUrlSafeMarker||hasGeneralMarker) && (hasUpper || hasDigit)) || (hasUpper && hasLower) || (hasDigit && (hasUpper || hasLower)))
		return (hasGeneralMarker ? BASE64 : BASE64URL);
}

function base64RunEnd(input, position, dictionary) {
	let end = position;
	while (end < input.length && BASE64_CHAR.test(input[end])) end += 1;

	if (dictionary !== undefined) {
		for (let candidateStart = position + 1; candidateStart < end; candidateStart += 1) {
			if (findDictionaryToken(input, candidateStart, dictionary) != null) {
				end = candidateStart;
				break;
			}
		}
	}
	return end;
}

function findBase64Token(input, position, dictionary) {
	const end = base64RunEnd(input, position, dictionary);
	const value = input.slice(position, end);
	let typeFlag = hasBase64Shape(value);
	if (null == typeFlag) return null;

	const fullOutLen = ((value.length + 3) / 4 | 0) * 3;
	const buffer = new Uint8Array(1 + fullOutLen);

	const decoder = createBase64Decoder(fullOutLen);
	const generator = decoder.decode(value);

	let index = 1;
	for (const chunk of generator) {
		buffer.set(chunk, index);
		index += chunk.length;
	}
	const chunk = decoder.finish();
	buffer.set(chunk, index);
	index += chunk.length;

	if (value.endsWith("=")) typeFlag |= 2;

	const bytes = buffer.subarray(0, index);
	if (base64Encode(bytes.subarray(1), typeFlag) !== value) return null;

	buffer[0] = typeFlag;
	return [bytes, end];
}

/**
 * Compress one string into dictionary indexes, literal strings and typed byte
 * tokens. Dictionary matching is longest-first; built-in formats are detected
 * at the current position when no dictionary entry matches.
 *
 * @param {string} input
 * @param {string[]} dictionary
 * @returns {string | (number|string|Uint8Array)[]}
 */
export function compressStr(input, dictionary = []) {
	if (typeof input !== "string") throw new TypeError("input must be a string");

	const output = [];
	let literal = "";
	let position = 0;

	const flushLiteral = () => {
		if (!literal) return;

		const last = output.at(-1);
		if (typeof last === "string") output[output.length - 1] = last + literal;
		else output.push(literal);

		literal = "";
	};

	while (position < input.length) {
		const dictionaryIndex = findDictionaryToken(input, position, dictionary);
		if (dictionaryIndex != null) {
			flushLiteral();
			output.push(dictionaryIndex);
			position += dictionary[dictionaryIndex].length;
			continue;
		}

		const uuid = findUuidToken(input, position);
		if (uuid && !uuid.mixedCase) {
			flushLiteral();
			output.push(uuid);
			position += 36;
			continue;
		}

		const hex = findHexToken(input, position);
		if (hex) {
			flushLiteral();
			output.push(hex);
			position += (hex.length - 1) * 2;
			continue;
		}

		// Do not reinterpret a mixed-case UUID as Base64 merely because '-' is in
		// the URL-safe alphabet.
		if (!uuid?.mixedCase) {
			const base64 = findBase64Token(input, position, dictionary);
			if (base64) {
				flushLiteral();
				output.push(base64[0]);
				position = base64[1];
				continue;
			}
		}

		literal += input[position];
		position += 1;
	}

	if (!output.length) return input;

	flushLiteral();
	return output;
}


/**
 * @param {string} input
 * @returns {string | [Uint8Array]}
 */
export function compressBase64(input) {
	const base64 = findBase64Token(input, 0, []);
	if (base64 && base64[1] === input.length) return [base64[0]];
	return input;
}

/**
 * Expand the output of compress back into one string.
 *
 * @param {(number|string|Uint8Array)[]} tokens
 * @param {string[]} dictionary
 * @returns {string}
 */
export function decompressStr(tokens, dictionary = []) {
	if (!Array.isArray(tokens)) throw new TypeError("tokens must be an array");

	let result = "";
	for (const token of tokens) {
		const type = typeof token;
		switch (type) {
			case 'string':
				result += token;
				break;
			case 'number':
				const string = dictionary[token];
				if (string == null) throw new RangeError(`Dictionary index out of range: ${token}`);
				result += string;
				break;
			case 'object':
				if (token instanceof Uint8Array) {
					const type = token[0], bytes = token.subarray(1);

					let hex;
					switch (type) {
						default: throw new RangeError(`Unknown format: ${type}`);
						case BASE64:case BASE64URL:case BASE64PAD:case BASE64URLPAD:
							result += base64Encode(bytes, type);
						continue;
						case HEX: result += bytesToHex(bytes); continue;
						case HEX_UPPER: result += bytesToHex(bytes).toUpperCase(); continue;
						case UUID: hex = bytesToHex(bytes); break;
						case UUID_UPPER: hex = bytesToHex(bytes).toUpperCase(); break;
					}
					if (hex.length !== 32) throw new RangeError("UUID payload must be 16 bytes");
					result += `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
					break;
				}
			// noinspection FallThroughInSwitchStatementJS
			default: throw new TypeError("Invalid compressed token");
		}

	}

	return result;
}
