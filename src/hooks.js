import {EVENT_BUS} from "./states.js";

/** @type {import("unconscious/common/components/Filter").FilterInstance} */
export let DI_settings;
/** @type {HTMLElement} */
export let DI_messageContainer;

export const DI = {};

/**
 * @param {function(HTMLBodyElement): void} callback
 */
export const onLoad = callback => EVENT_BUS.on('load', callback);

export const injectCommonDI = (set, mc) => {
	DI_settings = set;
	DI_messageContainer = mc;
};