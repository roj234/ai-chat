
const createHandle = (func) => (str, ...args) => {
	let template = `[${new Date().toLocaleTimeString()}] `;
	if (typeof str === 'string') {
		template = str.split('\n').map(s => template+s).join('\n');
		func(template, ...args)
	} else {
		func(template, str, ...args);
	}
};

for (const key of Object.keys(console))
	console[key] = createHandle(console[key]);
