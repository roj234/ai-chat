import {EVENT_BUS} from "./states.js";

/** @type {import("unconscious/common/components/Filter").FilterInstance} */
export let DI_settings;
/** @type {HTMLElement} */
export let DI_messageContainer;
/** @type {HTMLElement & {}} */
export let DI_messageVirtualList;

export const DID_SYNC_LOCK = 0;
export const DID_SYNC_UNLOCK = 1;
export const DID_RMI = 2;
export const DID_SEND_BUTTON = 3;
export const DID_TITLE_POSITION = 4;

/**
 * 统一管理的依赖注入对象
 * @type {[
 *     function(number): void,
 *     function(number): void,
 *     Object,
 *     HTMLButtonElement,
 *     HTMLElement,
 * ]}
 */
export const DI = [];

/**
 * @param {function(HTMLBodyElement): void} callback
 */
export const onLoad = callback => EVENT_BUS.on('load', callback);

export const injectCommonDI = (set, mc) => {
	DI_settings = set;
	DI_messageContainer = mc;
	DI_messageVirtualList = mc.querySelector("._vl");
};