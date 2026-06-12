
const log = console.log;
const error = console.error;

export function injectLogger() {
	const createHandle = (func) => (str, ...args) => {
		let template = `[${new Date().toLocaleTimeString()}] `;
		if (typeof str === 'string') {
			template = str.split('\n').map(s => template+s).join('\n');
			func(template, ...args)
		} else {
			func(template, str, ...args);
		}
	};

	console.log = createHandle(log);
	console.error = createHandle(error);
}