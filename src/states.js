import {$asyncState, $state, $store, $update, $watch} from 'unconscious';
import {jsonFetch} from "./utils/utils.js";
import {isEqual} from "../vendor/equals.js";

export const isMobile = matchMedia('(max-width: 768px)').matches;

/**
 *
 * @type {{
 * completionTemplate: function(OpenAI.Message[]): string,
 * additionalBody: Record<string, any>,
 * stop: string[],
 * antiSlop: Record<string, number>
 * }}
 */
export const state = {};

/**
 * @type {Record<string, AiChat.DnD.CustomMessageRole>}
 */
export const MessageRoles = {};

export const inputText = $state("");//$store("inputText", "", {persist: true});


/**
 * @type {import("unconscious").Reactive<AiChat.Preset>}
 */
export const config = $store("config", {
	endpoint: DEFAULT_LLM_ENDPOINT,
	mode: 'chat',

	reasoning: 'medium',

	maxToolTurns: 10,
	sound: false,

	generateTitle: false,

	max_tokens: 10000,
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

export function setIsLlamaCppBackend(b, b2) {
	isLlamaCppBackend = b;
	isMyLlamaCppBackend = b2;
}

/**
 * @type {import("unconscious").ReactivePromise<AiChat.ApiModel[]>}
 */
export const models = $asyncState(endpoint => {
	return !endpoint?.url ? [] : jsonFetch(endpoint.url + "/models", { authorization: endpoint.token }).then(({data}) => data);
}, _modelEndpoint);

/**
 * @param {boolean=} force
 * @return {import("unconscious").ReactivePromise<AiChat.ApiModel[]>}
 */
export function updateModels(force) {
	const value = {
		url: config.endpoint,
		token: config.accessToken
	};
	if (!isEqual(value, _modelEndpoint.value)) _modelEndpoint.value = value;
	if (force) $update(_modelEndpoint);
	return models;
}

/**
 *
 * @type {{
 *     scroller: HTMLElement,
 *     sendBtn: HTMLButtonElement,
 *     SettingUI: HTMLElement,
 *     statusBadge: HTMLElement,
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
	abortCompletion.value = runningConversations.get(selectedConversation.id)?.abort;
});

export const resumableCompletions = $store("resumableCompletions", {}, {persist: true, deep: false});