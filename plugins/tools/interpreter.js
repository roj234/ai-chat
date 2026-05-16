import MyWorker from './interpreter.worker.js?worker&inline';
import {registerTools} from "/src/skills.js";

let worker;
function stopWorker() {
	worker?.terminate();
	worker = null;
}

const MAX_LOG_LENGTH = 5000;

export const interpreter = {
	name: "execute_javascript",
	description: "Run javascript in WebWorker sandbox, 不支持 import/require, 仅能访问内置对象. 可用于数学计算、字符串处理、原型验证等.",
	parameters: {
		type: "object",
		properties: {
			code: { type: "string", description: "A self-invoking expression or use `return`. Output is captured from the final return value or `console.log`" }
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
			function getLog() {
				return trimmedChars ? "Trimmed "+trimmedChars+" characters.\n\n"+log : log;
			}

			const timer = setTimeout(() => {
				stopWorker();
				reject({
					error: "TimeoutError ("+timeout+"s)",
					log: getLog()
				});
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

				const base = log ? { log: getLog() } : {};

				if ("result" in data) {
					resolve({
						result: data.result,
						...base
					});
				} else {
					reject({
						...data,
						...base
					});
				}
			};
			worker.postMessage(code);
		});
	}
};

registerTools("interpreter", "安全的执行 JavaScript 代码. 可用于数学计算、字符串处理、原型验证等。", [interpreter]);
