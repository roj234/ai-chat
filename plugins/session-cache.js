import {onLoad} from "../src/hooks.js";
import {config, EVENT_BUS, onConversationLoaded} from "../src/states.js";
import {LRUCache} from "../common/LRUCache.js";
import {GLOBAL_SETTINGS} from "../src/settings.js";

GLOBAL_SETTINGS.push({
	_tab: "data",
	id: "messageCacheCap",
	name: "消息缓存容量",
	title: "在内存中至少保留最近打开的N个会话的全量消息，而不是每次从服务器拉取。",
	type: "number",
	min: 0,
	default: 20,
	max: 50
})

onLoad(() => {
	const capacity = config.messageCacheCap;
	if (!capacity) return;

	const messageCache = new LRUCache(capacity, { keyType: Uint32Array });

	EVENT_BUS.on('convDel', (data, path) => {messageCache.delete(path[1]);});

	const callback = (id) => {messageCache.get(id);};
	EVENT_BUS.on('lock', callback);
	EVENT_BUS.on('unlock', callback);

	const callback2 = (conv, path, messages) => {messageCache.set(conv.id, messages.raw ?? messages);};
	EVENT_BUS.on('convNew', callback2);
	onConversationLoaded(callback2);
});