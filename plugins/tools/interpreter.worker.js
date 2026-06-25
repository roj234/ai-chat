import {lockdown} from "unconscious/common/safe-worker/lockdown.js";

self.console = {
	log: function() {
		postMessage({log: Array.from(arguments).map(value => typeof value === "object" ? JSON.stringify(value) : value).join("")});
	}
};

const postMessage = self.postMessage.bind(self);
self.onmessage = (e) => {
	try {
		let fn;
		if (!e.data.includes("\n")) {
			try {
				fn = new Function("return "+e.data);
			} catch (e) {}
		}
		if (!fn) fn = new Function(e.data);

		const result = fn();
		postMessage({result});
	} catch (e) {
		postMessage({
			detail: e.message,
			error: e.name
		});
	}
};

lockdown();