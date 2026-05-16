import {applyDelta, streamFetch} from "../../common/openai-api-utils.js";

/**
 * @param {number} concurrency
 * @return {function(string, Object, string): Promise<OpenAI.ChatCompletionChunk>}
 * @constructor
 */
export const ParallelInference = function (concurrency = 100) {
	const taskQueue = new Set;

	this.enqueue = async runTask => {
		while (taskQueue.size >= concurrency) {
			await Promise.race(taskQueue);
		}

		const self = runTask().then(() => {
			taskQueue.delete(self);
			this.completedCount++;
		});
		taskQueue.add(self);
	};
	this.finish = () => Promise.all(taskQueue);
	this.completedCount = 0;
	this.totalCount = 0;

	const activeTPS = new Map();
	let lastUpdate;

	const updateStatusLine = () => {
		const time = Date.now();
		if (time - lastUpdate < 1000/60) return;
		lastUpdate = time;

		const tpsSum = Array.from(activeTPS.values()).reduce((sum, v) => sum + v.tps, 0);
		const activeCount = activeTPS.size;
		const percent = ((this.completedCount / this.totalCount) * 100).toFixed(1);
		process.stdout.write(
			`\r⏳ 进行中: ${activeCount}/${concurrency} │ 已完成: ${this.completedCount}/${this.totalCount} (${percent}%) │ 总TPS: ${tpsSum.toFixed(2)}  `
		);
	};

	this.invokeAPI = async (baseUrl, body, key) => {
		const completion = {};
		try {
			await streamFetch(baseUrl+"chat/completions", {
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(3000000),
				authorization: "Bearer "+key
			}, chunk => {
				const {choices, timings} = chunk;

				// 更新 TPS 状态
				if (timings) {
					activeTPS.set(completion, {
						tps: timings.predicted_per_second || 0,
						tokens: timings.predicted_n || 0
					});
					updateStatusLine();
				}

				let out_choices = completion.choices || (completion.choices = []);
				for (let i = 0; i < choices.length; i++) {
					const {delta, ...rest} = choices[i];
					if (!out_choices[i]) out_choices[i] = {delta: {}};

					if (delta.reasoning || delta.reasoning_content || delta.content) {
						if (!timings) {
							// 假设服务器每一个token发一个包
							const obj = activeTPS.get(completion);
							if (obj) {
								obj.tokens++;
								obj.tps = obj.tokens / (Date.now() - obj.time) * 1000;
							} else {
								activeTPS.set(completion, {
									tps: 1,
									tokens: 1,
									time: Date.now()
								});
							}
							updateStatusLine();
						}
					}
					Object.assign(out_choices[i], rest);
					applyDelta(out_choices[i].delta, delta);
				}

				delete chunk.choices;
				Object.assign(completion, chunk);
			});
		} finally {
			activeTPS.delete(completion);
		}
		return completion;
	};
};

