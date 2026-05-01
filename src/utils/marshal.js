import {getBlob, updateBlob} from "../database.js";
import {deepEntries} from "../../vendor/jsonSchema.js";

async function decodeDollar(val, zr) {
	switch (val.$) {
		case "Blob":
			if (!zr) throw "找不到引用的 Blob 对象";
			const data = await zr.get("blobs/" + val.index);
			if (!data) throw "找不到引用的 Blob 对象";
			return new Blob([data], {type: val.type});
		case "BlobH":return await getBlob(val);
		case "Map":return new Map(val.value);
		case "Set":return new Set(val.value);
		default: throw "不支持的数据类型:"+val.$;
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
		if (val.$) own[key] = await decodeDollar(val, zr);
	}
	return input;
}

/**
 *
 * @param {Object} messages
 * @param {Map<any, Object>} mapping
 * @param {ZipWriter=} zw
 * @return {Promise<void>}
 */
export function encodeObjects(messages, mapping, zw) {
	const promises = [];
	for (const [val, own, key] of deepEntries(messages)) {
		if (val instanceof Blob) {
			if (zw) {
				promises.push(val.arrayBuffer().then(ab => {
					const blobName = zw.fileCount();

					mapping.set(val, {
						$: "Blob",
						type: val.type,
						index: blobName
					});

					return zw.add("blobs/"+blobName, new Uint8Array(ab));
				}));
			} else {
				promises.push(updateBlob(val).then(hash => {
					mapping.set(val, {
						$: "BlobH",
						hash,
						name: val.name
					});
				}));
			}
		} else {
			if (import.meta.env.DEV && key === "url") {
				promises.push(fetch(val).then(r => r.blob()).then(async ab => {
					const blobName = zw.fileCount();

					mapping.set(val, {
						$: "Blob",
						type: ab.type,
						index: blobName
					});

					return zw.add("blobs/"+blobName, new Uint8Array(await ab.arrayBuffer()));
				}));
			}

			if (val instanceof Map) {
				mapping.set(val, {
					$: "Map",
					value: [...val]
				});
			} else if (val instanceof Set) {
				mapping.set(val, {
					$: "Set",
					value: [...val]
				});
			}
		}
	}
	return Promise.all(promises);
}