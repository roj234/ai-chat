let listeners = [];

/**
 * @param {function(HTMLBodyElement): void} callback
 */
export const onLoad = callback => listeners.push(callback);

export const callOnLoadHandler = app => {
	for (const listener of listeners) listener(app);
	listeners = null;
};