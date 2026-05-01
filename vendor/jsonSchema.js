import {isEqual} from "/vendor/equals.js";
import {isPureObject} from "unconscious";

/**
 *
 * @param {Object} obj
 * @param {Set<Object>} seen
 * @return {Generator<any, Object, string>}
 */
export function* deepEntries(obj, seen = new Set()) {
	if (obj === null || typeof obj !== 'object') return;
	if (seen.has(obj)) return;
	seen.add(obj);

	for (const key of Object.getOwnPropertyNames(obj)) {
		const value = obj[key];
		yield [value, obj, key];
		if (value && typeof value === 'object') {
			yield* deepEntries(value, seen);
		}
	}
}

/**
 *
 * @param {string} path
 * @param {'.' | '/'} separator
 * @return {string[]}
 */
export const parseJsonPath = (path, separator = '.') => {
	const keys = path.split(separator);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (key.endsWith("]")) {
			const j = key.indexOf("[");
			const pre = key.substring(0, j);
			const post = key.substring(j+1, key.length-1);
			keys.splice(i, 1, pre, post);
			i++;
		}
	}
	return keys;
}

export const jsonGet = (obj, path) => {
	const keys = Array.isArray(path) ? path : parseJsonPath(path);

	for (let i = 0; i < keys.length - 1; i++) {
		obj = obj[keys[i]];
		if (!obj) return;
	}

	return obj[keys[keys.length - 1]];
};


export function compileSchema(input) {
	for (const [val, own, key] of deepEntries(input)) {
		const $ref = val.$ref;
		if ($ref) own[key] = jsonGet(input, parseJsonPath($ref.substring(2), '/'));

		// 这块是AI写的，我也不是很懂.jpg
		if (key === "oneOf" || key === "anyOf") {
			// 保证 val 是非空数组
			if (!Array.isArray(val) || val.length === 0) continue;

			// 1. 递归解析子模式中的 $ref，避免未展开的引用干扰公共前缀提取
			for (const sub of val) {
				for (const [v, o, k] of deepEntries(sub, new Set())) {
					const r = v.$ref;
					if (r) o[k] = jsonGet(input, parseJsonPath(r.substring(2), '/'));
				}
			}

			// 2. 提取公共前缀
			const first = val[0];
			if (typeof first !== 'object' || first === null) continue; // 非普通对象无法提取公共属性

			const common = {};
			for (const k of Object.keys(first)) {
				const firstVal = first[k];
				let allHave = true;
				for (let i = 1; i < val.length; i++) {
					const sub = val[i];
					if (!(k in sub) || !isEqual(sub[k], firstVal)) {
						allHave = false;
						break;
					}
				}
				if (allHave) {
					common[k] = firstVal;
				}
			}

			// 3. 若找到公共前缀，则用 allOf 取代 oneOf/anyOf
			if (Object.keys(common).length > 0) {
				const newAllOf = [common, { [key]: val }];

				if (own.allOf) {
					// 已有 allOf，合并：将原有 allOf 插入到 common 和包含原数组的对象之间。
					const existing = Array.isArray(own.allOf) ? own.allOf : [own.allOf];
					own.allOf = [common, ...existing, { [key]: val }];
				} else {
					own.allOf = newAllOf;
				}
				delete own[key];
			}
		}
	}
	return input;
}

/**
 *
 * @param {any} o
 * @param {OpenAI.Schema} schema
 * @param {string} path
 */
export function validate(o, schema, path = "$") {
	const candidates = schema.const ? [schema.const] : schema.enum;
	found:
	if (candidates?.length) {
		for (let candidate of candidates) {
			if (isEqual(candidate, o))
				break found;
		}
		throw path+": invalid enum value";
	}

	const {default: def, type: types} = schema;

	if (o == null && def !== undefined)
		return def;

	const isType = (type) => {
		switch (type) {
			case 'value':
				return true;
			case 'null':
				return type === null;
			case 'string':
			case 'boolean':
			case 'number':
				return typeof o === type;
			case 'object':
				return isPureObject(o);
			case 'array':
				return Array.isArray(o);
			case 'integer':
				return typeof o === 'bigint' || Number.isInteger(o);
		}
	}
	let matchType;

	checkTypeMatch:{
		if (Array.isArray(types)) {
			for (const t of types) {
				if (isType(matchType = t))
					break checkTypeMatch;
			}
		} else {
			if (types == null || isType(matchType = types))
				break checkTypeMatch;
		}

		throw path+": invalid type";
	}

	switch (matchType) {
		case 'object': {
			const {required = [], properties, additionalProperties = true} = schema;
			const requiredSet = new Set(required);
			for (const key of Object.keys(o)) {
				requiredSet.delete(key);

				let property = properties[key];
				if (!property) {
					if (!additionalProperties) {
						throw path+": additional property "+JSON.stringify(key);
					}
					if (additionalProperties === true) continue;
					property = additionalProperties;
				}

				o[key] = validate(o[key], property, path+"."+key);
			}

			for (const key of requiredSet) {
				let {default: def} = properties[key];
				if (def !== undefined) {
					o[key] = def;
					requiredSet.delete(key);
				}
			}

			if (requiredSet.size) {
				throw path+": missing required fields: "+JSON.stringify([...requiredSet]);
			}
		}
		break;
		case 'array': {
			const {minItems = 0, maxItems = NaN, items} = schema;
			const len = o.length;
			if (len < minItems || len > maxItems) {
				throw path+`: array length(${len}) not in range [${minItems}, ${maxItems}]`;
			}
			if (items) {
				for (let i = 0; i < len; i++) {
					o[i] = validate(o[i], items, path+"["+i+"]");
				}
			}
		}
		break;
		case 'string': {
			const {minLength = NaN, maxLength = NaN, pattern, format} = schema;
			const len = o.length;
			if (len < minLength || len > maxLength) {
				throw path+`: string length(${len}) not in range [${minLength}, ${maxLength}]`;
			}
			if (pattern && !new RegExp(pattern).test(o)) {
				throw path+": string("+JSON.stringify(o)+") not match pattern "+JSON.stringify(pattern);
			}
			// format 未实现 'date' | 'time' | 'date-time' | 'uri' | 'email' | 'hostname' | 'ipv4' | 'ipv6' | 'uuid'
		}
		break;
		case 'number':
		case 'integer': {
			const {minimum = NaN, maximum = NaN, exclusiveMinimum = NaN, exclusiveMaximum = NaN} = schema;
			if (o < minimum || o <= exclusiveMinimum || o > maximum || o >= exclusiveMaximum) {
				let str;
				str = exclusiveMinimum !== exclusiveMinimum ? '(' + exclusiveMinimum : '[' + minimum;
				str += ',';
				str += exclusiveMaximum !== exclusiveMaximum ? exclusiveMaximum + ')' : maximum + ']';
				throw path+`: number(${o}) not in range `+str;
			}
		}
		break;
	}

	let subSchemas = schema.anyOf;
	anyOf:
	if (subSchemas) {
		let lastError;
		for (let i = 0; i < subSchemas.length; i++){
			try {
				o = validate(o, subSchemas[i], path+"[anyOf]["+i+"]");
				break anyOf;
			} catch (e) {
				lastError = e;
			}
		}
		throw lastError;
	}

	if ((subSchemas = schema.allOf)) {
		for (let i = 0; i < subSchemas.length; i++){
			o = validate(o, subSchemas[i], path+"[allOf]["+i+"]");
		}
	}

	if ((subSchemas = schema.oneOf)) {
		let lastError;
		let lastSuccess;
		for (let i = 0; i < subSchemas.length; i++) {
			let result;
			try {
				result = validate(o, subSchemas[i], path+"[oneOf]["+i+"]");
			} catch (e) {
				lastError = e;
				continue;
			}

			if (lastSuccess !== undefined) throw path+": multiple oneOf matches";
			lastSuccess = result;
		}
		if (lastSuccess !== undefined) return lastSuccess;
		throw lastError;
	}

	return o;
}
