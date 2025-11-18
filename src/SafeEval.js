import MyWorker from './SafeEval.worker.js?worker&inline';

function restartWorker() {
	worker?.terminate();
	worker = new MyWorker();
}

let worker;
restartWorker();

const MAX_LOG = 2000;

/**
 *
 * @param {string} code
 * @param {number} timeout
 * @return {Promise<{type?: string, result?: any, log?: string}>}
 */
export function safeEval(code, timeout = 1000) {
	if (timeout !== timeout) timeout = 0;
	if (timeout < 100) timeout = 100;
	if (timeout > 10000) timeout = 10000;

	return new Promise((resolve, reject) => {
		let log = '';
		let trimmedChars = 0;
		const timer = setTimeout(() => {
			restartWorker();
			reject({
				error: "TimeoutError",
				log
			});
		}, timeout);

		worker.onmessage = e => {
			const data = e.data;

			if ("log" in data) {
				log += data.log+"\n";

				if (log.length > MAX_LOG) {
					const len = log.length-MAX_LOG;
					trimmedChars += len;
					log = "Trimmed "+trimmedChars+" characters.\n\n"+log.substring(len);
				}
				return;
			}

			clearTimeout(timer);

			if ("result" in data) {
				resolve({
					result: data.result,
					log
				});
			} else {
				reject({
					...data,
					log
				});
			}
		};
		worker.postMessage(code);
	});
}