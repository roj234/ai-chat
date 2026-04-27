let listeners = [];

/**
 * @param {function(HTMLBodyElement): void} callback
 */
export function onLoad(callback) {
	listeners.push(callback);
}

export function callOnLoadHandler(app) {
	for (const listener of listeners) listener(app);
	listeners = null;
}