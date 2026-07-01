import {lockdown} from "unconscious/common/safe-worker/lockdown.js";

const AsyncFunction = (async () => {}).__proto__.constructor;
const postMessage = self.postMessage.bind(self);
self.onmessage = async (e) => {
	try {
		const fn = AsyncFunction(e.data);
		const result = await fn();
		postMessage({result});
	} catch (e) {
		postMessage({error: e.name+": "+e.message});
	}
};

lockdown({
	console: {
		log(...args) {
			postMessage({log: args.map(value => typeof value === "object" ? JSON.stringify(value) : value).join(" ")});
		}
	}
});