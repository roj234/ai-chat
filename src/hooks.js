let listeners = [];

/** @type {import("unconscious/common/components/Filter").FilterInstance} */
export let DI_settings;
/** @type {HTMLElement} */
export let DI_messageContainer;

export const DI = {};

/**
 * @param {function(HTMLBodyElement): void} callback
 */
export const onLoad = callback => listeners.push(callback);

export const callOnLoadHandler = (app, set, mc) => {
	DI_settings = set;
	DI_messageContainer = mc;
	for (const listener of listeners) listener(app);
	listeners = null;
};