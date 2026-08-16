import MCPServer from "./utils/MCPServer.js";
import {compressGeneric, decompressGeneric, deserializeRow} from "./utils/compression.js";
import {jsonFetch} from "../common/openai-api-utils.js";
import {cachePreparedSql} from "./utils/sqliteUtils.js";
import {ZipReader} from "unconscious/common/zip-io.js";
import {LRUCache} from "../common/LRUCache.js";
import {IgnoreMatcher} from "../common/ignore.js";

globalThis.AiChatAPI = {
	IgnoreMatcher,
	MCPServer,
	LRUCache,
	jsonFetch,
	cachePreparedSql,
	ZipReader,
	compressGeneric,
	decompressGeneric,
	deserializeRow
};