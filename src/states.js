import {$asyncState, $computed, $state, $store, $watch, debugSymbol, unconscious} from 'unconscious';
import {jsonFetch} from "./utils/utils.js";
import {deepEqual} from "unconscious/common/deepEqual.js";

/**
 * @type {boolean}
 */
export let isMobile = IS_ANDROID_BUILD;

if (!IS_ANDROID_BUILD) {
	const isMobileQuery = matchMedia('(max-width: 768px)');
	const cb = () => {
		isMobile = isMobileQuery.matches;
	};
	isMobileQuery.onchange = cb;
	cb();
}

/**
 *
 * @type {{
 * completionTemplate: function(OpenAI.Message[]): string,
 * }}
 */
export const state = {};


export const MessageCopyHandler = debugSymbol("MessageCopy");

/**
 * @type {Record<string, AiChat.DnD.CustomMessageRole>}
 */
export const MessageRoles = {};
export const EditableMessageRoles = new Set(["system", "user", "assistant"]);

// 虽然记住是挺好的，但是自动同步功能会导致每一个页面的输入框内容都相同，有些离谱
export const inputText = $state("");//$store("inputText", "", {persist: true, ser: AS_IS, deser: AS_IS});


/**
 * @type {import("unconscious").Reactive<AiChat.Preset>}
 */
export const config = $store("config", {
	endpoint: DEFAULT_LLM_ENDPOINT,
	mode: 'chat',

	reasoning: 'medium',

	maxToolTurns: 1,
	sound: false,

	generateTitle: false,
	allowHTMLTags: ["basic"],

	jsonSupport: 0,
	max_tokens: 30000,
	top_p: 1,
	top_k: 0,
	min_p: 0,
}, {persist: true, deep: false});

/**
 * @type {import("unconscious").Reactive<AiChat.Message[]>}
 */
export const messages = $state([]);
/**
 * @type {import("unconscious").Reactive<AiChat.Conversation>}
 */
export const selectedConversation = $state(null);

const conversationLoadedCallbacks = [];
const conversationBeforeunloadCallbacks = [];
export const onConversationLoaded = callback => conversationLoadedCallbacks.push(callback);
export const onConversationBeforeunload = callback => conversationBeforeunloadCallbacks.push(callback);

let prevConversation;
$watch(selectedConversation, () => {
	if (selectedConversation.ready) {
		const conv = unconscious(selectedConversation);
		if (conv.id !== prevConversation?.id) {
			prevConversation = conv;
			const msg = unconscious(messages);
			for (const cb of conversationLoadedCallbacks) cb(conv, msg);
		}
	} else if (prevConversation) {
		for (const cb of conversationBeforeunloadCallbacks) cb(prevConversation);
		prevConversation = null;
	}
});


/**
 * @type {import("unconscious").Reactive<AiChat.Conversation[]>}
 */
export const conversations = $state([]);

export const beginConversation = () => {
	selectedConversation.value = null;
	messages.value = [];
};

/**
 * @type {import("unconscious").Reactive<{}>}
 * @private
 */
const _modelEndpoint = $state();

/**
 * @type {boolean}
 */
export let isLlamaCppBackend, isMyLlamaCppBackend;

export const setIsLlamaCppBackend = (b, b2) => {
	isLlamaCppBackend = b;
	isMyLlamaCppBackend = b2;
};

/**
 * @type {import("unconscious").ReactivePromise<AiChat.ApiModel[]>}
 */
export const models = $asyncState(endpoint => {
	return endpoint?.url ? jsonFetch(endpoint.url + "/models", {key: endpoint.key}).then(({data}) => data) : [];
}, _modelEndpoint);

/**
 * @param {boolean=} force
 * @return {import("unconscious").ReactivePromise<AiChat.ApiModel[]>}
 */
export const updateModels = force => {
	const value = {
		url: config.endpoint,
		key: config.accessToken
	};
	if (force || !deepEqual(value, _modelEndpoint.value)) _modelEndpoint.value = value;
	return models;
};

/**
 *
 * @type {{
 *     scroller: HTMLElement,
 *     sendBtn: HTMLButtonElement,
 *     SettingUI: HTMLElement,
 * }}
 */
export const Shared = {}

/**
 *
 * @type {import("unconscious").Reactive<boolean>}
 */
export const lastScrollDirection = $state();

/**
 *
 * @type {import("unconscious").Reactive<AbortController>}
 */
export const abortCompletion = $state();

/**
 *
 * @type {Map<number, {
 *     abort: AbortController,
 *     messages: AiChat.Message[]
 * }>}
 */
export const runningConversations = new Map;

$watch(selectedConversation, () => {
	abortCompletion.value = unconscious(runningConversations.get(selectedConversation.id)?.abort);
});


let nativeTheme;
{
	const root = document.querySelector(":root");
	const colorSchemeQuery = matchMedia('(prefers-color-scheme: dark)');
	const cb = () => {
		nativeTheme = colorSchemeQuery.matches ? 'dark' : 'light';
		root.setAttribute("data-theme", config.theme || nativeTheme);
	};
	$watch($computed(() => config.theme), cb);
	colorSchemeQuery.onchange = cb;
}

/**
 * @return {'light' | 'dark'}
 */
export const getCurrentTheme = () => config.theme || nativeTheme;