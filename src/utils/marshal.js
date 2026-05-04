import {getBlob, updateBlob} from "../database.js";
import {deepEntries} from "/common/jsonSchema.js";

async function decodeDollar(v, zr) {
	const v1 = v.v;
	switch (v.$) {
		case "Blob": {
			if (zr) {
				const data = await zr.get("blobs/"+v.index);
				if (data) return new Blob([data], {type: v.type});
			}
			throw "找不到引用的 Blob 对象";
		}
		case "BlobH":return await getBlob(v);
		case "Map":return new Map(v1);
		case "Set":return new Set(v1);
		case "Date":return new Date(v1);
		case "RegExp": {
			const pos = v1.lastIndexOf('/');
			return new RegExp(v1.slice(1, pos), v1.substring(pos+1));
		}
		case "BigInt":return BigInt(v1);
		default: return v;
	}
}

/**
 * @template {Object} T
 * @param {T} input
 * @param {openZip=} zr
 * @return {Promise<T>}
 */
export async function decodeObjects(input, zr) {
	if (input?.$) return decodeDollar(input, zr);
	for (const [val, own, key] of deepEntries(input)) {
		if (val?.$) own[key] = await decodeDollar(val, zr);
	}
	return input;
}

/**
 *
 * @param {Object} input
 * @param {Map<any, Object>} replacer
 * @param {ZipWriter=} zipWriter
 * @return {Promise<void>}
 */
export function encodeObjects(input, replacer, zipWriter) {
	const promises = [];
	for (const [val] of deepEntries(input)) {
		const fn = val?.constructor;
		switch (fn) {
			case Blob:
			case File:
				promises.push(zipWriter ? val.arrayBuffer().then(ab => {
					const blobIndex = zipWriter.fileCount();

					replacer.set(val, {
						$: "Blob",
						type: val.type,
						name: val.name,
						index: blobIndex
					});

					return zipWriter.add("blobs/"+blobIndex, new Uint8Array(ab));
				}): updateBlob(val).then(hash => {
					replacer.set(val, {
						$: "BlobH",
						hash,
						name: val.name
					});
				}));
			break;
			case Map:
			case Set:
				replacer.set(val, {
					$: fn.name,
					v: [...val]
				});
			break;
			case Date:
				replacer.set(val, {
					$: fn.name,
					v: val.getTime()
				});
			break;
			case RegExp:
			case BigInt:
				replacer.set(val, {
					$: fn.name,
					v: val.toString()
				});
			break;
		}
	}
	return Promise.all(promises);
}