import MyWorker from './interpreter.worker.js?worker&inline';
import {registerTools} from "/src/skills.js";

let worker;
function stopWorker() {
	worker?.terminate();
	worker = null;
}

const MAX_LOG_LENGTH = 5000;

export const CodeRunner = {
	name: "CodeRunner",
	description: "Run sandboxed JavaScript in a Worker for exact calculation, data transformation, string processing, and quick algorithm validation.",
	parameters: {
		type: "object",
		properties: {
			code: { type: "string", description: "Body of an async function" +
					"\n- Supports await" +
					"\n- Use return or console.log to output." +
					"\n- Output must be structuredClone-able" +
					"\n- Network/file/import APIs are not available.", }
		},
		required: ["code"]
	},

	/**
	 * @param {string} code
	 * @param {number} timeout
	 * @return {Promise<{type?: string, result?: any, log?: string}>}
	 */
	script({code}) {
		const timeout = 3;

		return new Promise((resolve, reject) => {
			let log = '';
			let trimmedChars = 0;
			const getLog = () => log && ("\nLog:\n"+(trimmedChars ? "Trimmed " + trimmedChars + " characters.\n\n" + log : log));

			const timer = setTimeout(() => {
				stopWorker();
				reject("Error: Timeout"+getLog());
			}, timeout * 1000);

			if (!worker) worker = new MyWorker();

			worker.onmessage = e => {
				const data = e.data;

				if ("log" in data) {
					log += data.log+"\n";

					if (log.length > MAX_LOG_LENGTH) {
						const len = log.length-MAX_LOG_LENGTH;
						log = log.slice(len);
						trimmedChars += len;
					}

					return;
				}

				clearTimeout(timer);

				if ("result" in data) {
					resolve("Result:\n"+JSON.stringify(data.result)+getLog());
				} else {
					reject(data.error+getLog());
				}
			};
			worker.postMessage(code);
		});
	}
};

registerTools("CodeRunner", "Run sandboxed JavaScript for calculation, such as string processing and algorithm validation.", [CodeRunner]);
