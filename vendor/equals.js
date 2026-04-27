
'use strict';

// do not edit .js files directly - edit src/index.jst

// https://www.npmjs.com/package/fast-deep-equal
export function isEqual(a, b, ignoredKeys) {
	if (a === b) return true;

	if (a && b && typeof a == 'object' && typeof b == 'object') {
		if (a.constructor !== b.constructor) return false;

		var length, i;
		if (Array.isArray(a)) {
			length = a.length;
			if (length !== b.length) return false;
			for (i = length; i-- !== 0;)
				if (!isEqual(a[i], b[i])) return false;
			return true;
		}

		if ((a instanceof Map) && (b instanceof Map)) {
			if (a.size !== b.size) return false;
			for (i of a.entries())
				if (!b.has(i[0])) return false;
			for (i of a.entries())
				if (!isEqual(i[1], b.get(i[0]))) return false;
			return true;
		}

		if ((a instanceof Set) && (b instanceof Set)) {
			if (a.size !== b.size) return false;
			for (i of a.entries())
				if (!b.has(i[0])) return false;
			return true;
		}

		if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
			length = a.length;
			if (length !== b.length) return false;
			for (i = length; i-- !== 0;)
				if (a[i] !== b[i]) return false;
			return true;
		}


		if (a.constructor === RegExp) return a.source === b.source && a.flags === b.flags;
		if (a.valueOf !== Object.prototype.valueOf) return a.valueOf() === b.valueOf();
		if (a.toString !== Object.prototype.toString) return a.toString() === b.toString();

		let keysa = Object.keys(a), keysb = Object.keys(b);

		if (ignoredKeys) {
			const predicate = name => !ignoredKeys.has(name);
			keysa = keysa.filter(predicate);
			keysb = keysb.filter(predicate);
		}

		length = keysa.length;
		if (length !== keysb.length) return false;

		for (i = length; i-- !== 0;)
			if (!Object.prototype.hasOwnProperty.call(b, keysa[i])) return false;

		for (i = length; i-- !== 0;) {
			var key = keysa[i];

			if (!isEqual(a[key], b[key])) return false;
		}

		return true;
	}

	// true if both NaN, false otherwise
	return a!==a && b!==b;
};
