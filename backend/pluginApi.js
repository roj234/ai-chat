import MCPServer from "./utils/MCPServer.js";
import {compressGeneric, decompressGeneric, KNOWN_KVS} from "./utils/compression.js";
import {jsonFetch} from "../common/fetch-utils.js";
import {cachePreparedSql} from "./utils/sqliteUtils.js";
import {ZipReader} from "@roj234/jszip/io";
import {LRUCache} from "@roj234/lru-cache";
import {ACL} from "../common/ACL.js";
import {parseProviderFile} from "./api-proxy/providerFile.js";
import {advancedLLMProxy} from "./api-proxy/api-proxy.js";

globalThis.AiChatAPI = {
	ACL,
	MCPServer,
	LRUCache,
	KNOWN_KVS,
	jsonFetch,
	cachePreparedSql,
	ZipReader,
	compressGeneric,
	decompressGeneric,
	parseProviderFile,
	advancedLLMProxy
};