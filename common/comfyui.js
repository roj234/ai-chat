import {inspect} from "@roj234/util-inspect";
import {randomUUID, throwDOMException} from "./pure-utils.js";
import {jsonFetch} from "./fetch-utils.js";
import {AS_IS, debugSymbol, UTF8_TEXT_DECODER} from "@roj234/shared";

const FRONTEND_NODES = new Set(["My_Notification", "MarkdownNote", "Reroute"]);

const INVALID = /^[^_\p{ID_Start}]|[^_\p{ID_Continue}]/gu;
const replacer = (m) => '$'+m.charCodeAt(0).toString(16);
/**
 * @param {string} str
 * @return {string}
 */
const escapeIdent = str => str.replace(INVALID, replacer);

/**
 * @param {Comfy.Graph} graph
 * @param {Set<string>} ignore
 * @return {string}
 */
export function compileWorkflow(graph, ignore = FRONTEND_NODES) {
	const nameCount = Object.create(null);
	const ID = (ident) => {
		if (/^[a-z]+$/.test(ident)) ident = '_'+ident;
		do {
			const counts = nameCount[ident] = (nameCount[ident] || 0) + 1;
			if (counts > 1) ident += '_'+counts;
		} while (nameCount[ident] > 1);
		return escapeIdent(ident);
	}

	let code = ``;

	const _gr = graph.groups ?? [];
	const boxes = new Float32Array(_gr.length * 4);
	/** @type {string[]} */
	const groups = [];
	for (let i = 0; i < _gr.length; i++) {
		const group = _gr[i];
		const [x1, y1, w, h] = group.bounding;
		boxes[(i << 2)] = x1;
		boxes[(i << 2) + 1] = y1;
		boxes[(i << 2) + 2] = x1 + w;
		boxes[(i << 2) + 3] = y1 + h;
		const id = ID(group.title || 'Group');
		groups.push(id);
		code += `const ${id} = cg.group(${JSON.stringify(group.title)});\n`;
	}

	const pendingLinks = Object.create(null);
	const removed = new Set;

	for (const node of graph.nodes) {
		const {
			id, type, title, mode = 0,
			pos, size,
			inputs = [], outputs = [],
			widgets_values_named = {}} = node;

		const varName = ID(title || type);

		/** @type {string[]} */
		const ownGroup = [];
		if (groups.length) {
			const [x1, y1] = pos;
			const x2 = x1 + size[0], y2 = y1 + size[1];
			for (let i = 0; i < groups.length; i++) {
				const X1 = boxes[(i << 2)];
				const Y1 = boxes[(i << 2) + 1];
				const X2 = boxes[(i << 2) + 2];
				const Y2 = boxes[(i << 2) + 3];

				if (X1<=x1&&Y1<=y1&&x2<=X2&&y2<=Y2) {
					ownGroup.push(groups[i]);
				}
			}
		}

		const myInputs = Object.create(null);
		const myOutputs = outputs.filter(s => s.links?.length).map(s => ({
			name: s.name,
			type: s.type
		}));

		if (!myOutputs.length && (ignore.has(type) || type.startsWith("Preview"))) {
			removed.add(id);
			continue;
		}

		for (const name of Object.keys(widgets_values_named)) {
			myInputs[name] = {
				value: widgets_values_named[name],
				// 事实上大部分时候这个TYPE根本读不到。先不管这种Bypass可能了
				// type: inputs.find(s => s.name === name)?.type
			};
		}

		inputs.forEach((input, i) => {
			if (input.link == null) return;
			myInputs[input.name] = {
				type: input.type
			};
			(pendingLinks[input.link] ??= {}).to = [id, i, varName, input.name, input.type];
		});
		outputs.forEach((output, i) => {
			output.links?.forEach(linkId => {
				(pendingLinks[linkId] ??= {}).from = [id, i, varName, output.name];
			})
		});

		const args = [JSON.stringify(type), inspect(myInputs), inspect(myOutputs)];

		let opt = [];
		if (title) opt.push(`name: ${JSON.stringify(title)}`);
		if (mode & 4) opt.push('bypass: true');
		if (mode & 2) opt.push('mute: true');
		if (ownGroup.length) opt.push(`groups: [${ownGroup.join(',')}]`);

		if (opt.length) args.push(`{${opt.join(', ')}}`);

		code += `const ${varName} = cg.node(${args.join(', ')});\n`;
	}

	const outLinks = Object.create(null);   // nodeId -> linkId[]
	const inDegree = Object.create(null);   // nodeId -> 未发出的入边数

	const links = graph.links;
	let removedLinks = 0;

	for (let i = 0; i < links.length; i++) {
		const [linkId, srcNode, srcId, dstNode, dstId, type] = links[i];
		const def = pendingLinks[linkId] ?? {};

		const {from, to} = def;
		if (!from || !to) {
			if (removed.has(srcNode) || removed.has(dstNode)) {
				removedLinks++;
				delete pendingLinks[linkId];
				continue;
			}

			throwDOMException(`Link ${linkId} 不完整`);
		}

		const [srcNode1, srcId1, srcVar] = from;
		const [dstNode1, dstId1, dstVar] = to;

		if (srcNode1 !== srcNode || srcId1 !== srcId || dstNode1 !== dstNode || dstId1 !== dstId) {
			throwDOMException(`Link ${linkId} 不合法`);
		}

		(outLinks[srcNode] ??= []).push(linkId);
		inDegree[dstNode] = (inDegree[dstNode] || 0) + 1;
	}

	// ---- 拓扑排序 ----

	const queue = [];
	for (const {id} of graph.nodes) {
		if (!inDegree[id]) queue.push(id);
	}

	const emitLink = (linkId) => {
		const { from, to } = pendingLinks[linkId];
		code += `cg.link(${from[2]}, ${from[1]}/* ${from[3]} */, ${to[2]}, ${JSON.stringify(to[3])});\n`;
	};

	const emitted = new Set;
	let head = 0;
	while (head < queue.length) {
		const id = queue[head++];
		const outs = outLinks[id];
		if (!outs) continue;

		for (let i = 0; i < outs.length; i++) {
			const linkId = outs[i];
			emitted.add(linkId);
			emitLink(linkId);
			const dst = pendingLinks[linkId].to[0];
			if (--inDegree[dst] === 0) queue.push(dst);
		}
	}

	if (emitted.size + removedLinks < links.length) {
		throwDOMException("图里有环");
	}

	return code;
}

export class NodeGraph {
	#groups = [];
	#nodes = [];
	#named = new Map;

	constructor(fn) {fn(this);}

	/**
	 * @param {string} name
	 * @return {number}
	 */
	group(name) {
		const group = {
			type: '#',
			name,
			nodes: []
		};
		this.#named.set(name, group);
		return this.#groups.push(group) - 1;
	}

	/**
	 *
	 * @param {string} type
	 * @param {Record<string, Comfy.CGInput>} inputs
	 * @param {Comfy.CGOutput[]} outputs
	 * @param {Comfy.CGNodeOptions} options
	 */
	node(type, inputs, outputs, options = {}) {
		const id = this.#nodes.length;
		const node = {
			id,
			type,
			inputs,
			outputs,
			bypass: options.bypass,
			mute: options.mute
		};
		this.#nodes.push(node);

		const name = options.name;
		const map = this.#named;
		if (name) map.set(name, node);

		// 如果只有一个 type 类型的节点，那么可以直接用类型做名称引用它。如果有两个或更多就不行
		else if (map.has(type)) map.set(type, undefined);
		else map.set(type, node);

		const groups = options.groups;
		if (groups) {
			for (let i = 0; i < groups.length; i++) {
				this.#groups[groups[i]].nodes.push(node);
			}
		}

		return id;
	}

	/**
	 * @param {number} fromNode
	 * @param {number} fromId
	 * @param {number} toNode
	 * @param {string} toName
	 */
	link(fromNode, fromId, toNode, toName) {
		const fr = this.#nodes[fromNode];
		const to = this.#nodes[toNode];

		to.inputs[toName].link = [fromNode, fromId];
		//(fr.outputs[fromId].links ??= []).push([toNode, toName]);
	}

	find(nodeName) {
		return this.#named.get(nodeName)?.id ?? -1;
	}

	/**
	 * @param {string} nodeName
	 * @param {string} property
	 * @param {Comfy.Primitive} value
	 */
	set(nodeName, property, value) {
		const node = typeof nodeName === 'number' ? this.#nodes[nodeName] : this.#named.get(nodeName);
		if (!node) throwDOMException(`Node ${nodeName} not found`);
		const input = node.inputs[property];
		if (!input) throwDOMException(`Property ${nodeName}.${property} not found`);
		input.value = value;
	}

	/**
	 * @param {string} nodeName
	 * @param {string} property
	 * @return {Comfy.Primitive}
	 */
	get(nodeName, property) {
		const node = typeof nodeName === 'number' ? this.#nodes[nodeName] : this.#named.get(nodeName);
		if (!node) throwDOMException(`Node ${nodeName} not found`);
		const input = node.inputs[property];
		if (!input) throwDOMException(`Property ${nodeName}.${property} not found`);
		return input.value;
	}

	/**
	 * @param {string} nodeOrGroup
	 * @param {boolean | undefined} value
	 * @param {'mute' | 'bypass'} [key]
	 */
	disable(nodeOrGroup, value, key = 'bypass') {
		const node = typeof nodeOrGroup === 'number' ? this.#nodes[nodeOrGroup] : this.#named.get(nodeOrGroup);
		if (node.type === '#') {
			for (const n of node.nodes) {
				if (value == null) n[key] ^= 1;
				else n[key] = value;
			}
		} else {
			if (value == null) node[key] ^= 1;
			else node[key] = value;
		}
	}

	validate(objectDef) {

	}

	/**
	 * @return {Comfy.ApiGraph}
	 */
	toJSON(prune) {
		const graph = Object.create(null);
		const nodes = this.#nodes;
		let stack = [];

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			if (!FRONTEND_NODES.has(node.type) && !node.bypass && !node.mute) {
				if (node.type.startsWith("Save")) stack.push(i);
			}
		}

		// 也许有什么新节点
		if (!stack.length) stack = [...nodes];

		const used = new Set;
		const seen = new Set;

		while (stack.length) {
			const i = stack.pop();
			if (used.has(i)) continue;
			const node = nodes[i];
			if (FRONTEND_NODES.has(node.type) || node.bypass || node.mute) continue;

			used.add(i);

			const inputs = Object.create(null);
			const keys = Object.keys(node.inputs);
			for (let j = 0; j < keys.length; j++) {
				const key = keys[j];
				let inp = node.inputs[key];

				seen.clear();
				outer:
				while(inp) {
					if (seen.has(inp)) throwDOMException("有环 "+i+":"+j);
					seen.add(inp);
					if (inp.link) {
						const fromId = inp.link[0];
						const from = nodes[fromId];
						const prevPrev = from.inputs;

						if (from.type === 'Reroute') {
							// 大肥鱼说输入名称【可能】是动态生成的，我信你一回？
							inp = prevPrev[""] ?? prevPrev[Object.keys(prevPrev)[0]];
							continue;
						}

						if (from.type === 'ComfySwitchNode') {
							const cst = prevPrev.switch.value;
							const isConstant = typeof cst === 'boolean';
							if (isConstant || from.bypass) {
								inp = prevPrev[!from.bypass && cst ? 'on_true' : 'on_false'];
								continue;
							}
						}

						if (!from.mute) {
							if (from.bypass) {
								for (let inKey in prevPrev) {
									// 选择第一个类型相同的节点
									if (prevPrev[inKey].type === inp.type) {
										inp = prevPrev[inKey];
										continue outer;
									}
								}
							} else {
								inputs[key] = [String(fromId), inp.link[1]];
							}
						}

						stack.push(fromId);
					} else if (inp.value !== undefined) {
						inputs[key] = inp.value;
					}

					break;
				}
			}

			graph[i] = {
				class_type: node.type,
				inputs
			};
		}

		return graph;
	}
}

const ARTIFACTS = debugSymbol("Files");
const CANCEL_IN_PROGRESS = debugSymbol("Cancelling");

const BINARY_TEXT = 3;
const BINARY_PREVIEW_IMAGE_WITH_METADATA = 4;

const ERR = (a, b) => new DOMException(a, b);

class PromptClient {
	/** @type {string} */
	#endpoint;

	#client_id = randomUUID();
	/** @type {WebSocket} */
	#ws;
	/** @type {number} */
	#idleTimeout;
	/** @type {Map<string, Comfy.ApiTask>} */
	#tasks = new Map;
	/** @type {Set<string>} */
	#started = new Set;
	/** @type {Comfy.ApiTask} */
	#current;
	/** @type {Promise<?>} */
	#init;
	/** @type {number} */
	#maxUploadSize;

	/**
	 * @param {string} endpoint
	 */
	constructor(endpoint) {
		this.#endpoint = endpoint;

		const ws = new WebSocket(endpoint.replace("http", "ws")+`/ws?clientId=${this.#client_id}&_reduce`);
		const taskDone = (taskId) => {
			this.#tasks.delete(taskId);
			this.#current = null;
			if (!this.#tasks.size) {
				this.#idleTimeout = setTimeout(() => this.close(), 60000);
			}
		};

		ws.binaryType = 'blob';
		this.#ws = ws;
		this.#init = new Promise((resolve, reject) => {
			let negotiation;
			ws.onopen = () => {
				ws.send(JSON.stringify({
					type: "feature_flags",
					data: {
						// 开了这个之后preview会有元数据，从而可以和WebSocketSaveImage区分
						supports_preview_metadata: true,
						// 这个会以文本形式(BINARY_TEXT)返回部分进度条，暂时用不上
						//supports_progress_text_metadata: true
					}
				}));
				negotiation = setTimeout(() => {
					reject(ERR("ComfyUI 无响应"));
					ws.close();
				}, 10000);
			};

			ws.onmessage = (event) => {
				// 处理字符串消息（状态更新）
				if (typeof event.data === 'string') {
					const {type, data} = JSON.parse(event.data);

					switch (type) {
						case 'feature_flags': {
							clearTimeout(negotiation);
							if (!data.supports_preview_metadata) {
								reject(ERR("ComfyUI 版本过低"));
								ws.close();
							} else {
								this.#maxUploadSize = data.max_upload_size;
								resolve();
							}
						}
						break;
						case 'status': {
							const queueRemaining = data.status.exec_info.queue_remaining;
							for (let task of this.#tasks.values()) {
								const currentStatus = task[2].status;
								if (currentStatus === 'pending') {
									task[1]({ status: 'pending', remaining: queueRemaining })
								}
							}
						}
						break;

						case 'execution_start': {
							const { prompt_id: taskId, timestamp } = data;
							const task = this.#tasks.get(taskId);
							if (!task) {
								this.#started.add(taskId);
								return;
							}

							task[2][CANCEL_IN_PROGRESS]?.();

							task[2].status = 'in_progress';
							task[1]({ status: 'in_progress', time: timestamp });

							this.#current = task;
						}
						break;
						case 'execution_cached': {
							const { prompt_id: taskId, timestamp, nodes } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							const state = task[2];
							state._c = state.fin = nodes.length;

							task[1]({ ...state, time: timestamp });
						}
						break;

						case 'progress': {
							const { prompt_id: taskId, node, value, max } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							const state = task[2];

							state.node = node;
							state.nfin = value;
							state.ntot = max;

							task[1](state);
						}
						break;
						case 'progress_state': {
							const { prompt_id: taskId, nodes } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							const state = task[2];

							let fin = state._c || 0;
							let node = null;
							let nfin = 0;
							let ntot = 0;

							for (const key in nodes) {
								const {value,max} = nodes[key];

								if (value !== 0) {
									if (value < max) {
										node = key;
										nfin = value;
										ntot = max;
									} else {
										fin++;
									}
								}
							}

							state.fin = fin;
							state.nfin = nfin;
							state.ntot = ntot;
							state.node = node;

							task[1](state);
						}
						break;
						case 'in_progress': {
							const { prompt_id: taskId, node } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							const state = task[2];

							state.node = node;
							state.ntot = state.nfin = 0;

							task[1](state);
						}
						break;
						case 'executed': {
							const { prompt_id: taskId, node, output } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							const state = task[2];

							state.node = node;
							state.ntot = state.nfin = 1;

							if (output) {
								const arr = state[ARTIFACTS] ??= [];
								for (const key of Object.keys(output)) {
									const type = key.slice(0, -1);
									const files = output[key];
									Array.isArray(files) && files.forEach(it => {
										const q = new URLSearchParams(it);

										arr.push({
											type,
											name: it.filename,
											node: parseInt(node),
											get: () => {
												const f = fetch(`${this.#endpoint}/view?${q}`);
												return f.then(r => r.ok ? r.blob() : throwDOMException("HTTP Error "+r.status));
											}
										});
									})
								}
							}

							task[1](state);
						}
						break;

						case 'execution_success': {
							const { prompt_id: taskId, timestamp } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;
							task[1]({ status: 'completed', time: timestamp });
							Promise.all(task[2][ARTIFACTS] || []).then(items => task[3](items.filter(Boolean)), err => task[4](err));
							taskDone(taskId);
						}
						break;
						case 'execution_error': {
							const { prompt_id: taskId, node_id, exception_type, exception_message, traceback } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							task[1]({ status: 'failed' });

							const error = new Error(exception_message);
							error.name = exception_type;
							error.stack = Array.isArray(traceback) ? traceback.join('\n') : traceback;
							error.node = node_id;
							task[4](error);
							taskDone(taskId);
						}
						break;
						case 'execution_interrupted': {
							const { prompt_id: taskId } = data;
							const task = this.#tasks.get(taskId);
							if (!task) return;

							task[1]({ status: 'cancelled' });
							task[4](ERR('aborted', 'AbortError'));
							taskDone(taskId);
						}
						break;
					}
				} else {
					/** @type {Blob} */
					const data = event.data;
					const current = this.#current;

					const promise = (async(current) => {
						const ab = await data.slice(0, 8).arrayBuffer();
						const dv = new DataView(ab);
						const evt = dv.getUint32(0);
						const jsonLength = dv.getUint32(4);

						if (evt === BINARY_PREVIEW_IMAGE_WITH_METADATA) {
							const meta = JSON.parse(UTF8_TEXT_DECODER.decode(new Uint8Array(await data.slice(8, 8+jsonLength).arrayBuffer())));
							const {node_id, prompt_id, image_type} = meta;

							if (image_type.startsWith('image/')) {
								const task = prompt_id === current?.[2]._id ? current : this.#tasks.get(prompt_id);
								if (task) {
									const isSaveNode = task[0][node_id].class_type === 'SaveImageWebsocket';
									const image = new Blob([data.slice(8+jsonLength)], { type: image_type });
									if (isSaveNode) {
										const p = Promise.resolve(image);
										const artifact = {
											type: 'image',
											name: 'image.'+image_type.slice(6),
											get: () => p,
										};

										if (task === current) return artifact;
										else (task[2][ARTIFACTS] ??= []).push(artifact);
									} else {
										if (task[1]) {
											task[1]({ status: 'preview', node: node_id, data: image });
										}
									}
								}
							}
						}
					})(current);

					if (current) {
						(current[2][ARTIFACTS] ??= []).push(promise);
					}
				}
			};

			ws.onerror = (ev) => {
				const error = ERR(`WebSocket 错误`);
				reject(error);
				for (let value of this.#tasks.values()) {
					value[4](error);
					value[5].cancel();
				}
			};

			ws.onclose = () => this.close();
		})
	}

	/**
	 * 上传文件
	 * @param {Blob | File} file
	 * @param {string} [name]
	 * @return {Promise<*>}
	 */
	async upload(file, name) {
		if (!(file instanceof Blob) && !(file instanceof Uint8Array)) {
			throwDOMException("excepted Blob or Buffer, received "+file);
		}
		if (this.#maxUploadSize && file.size > this.#maxUploadSize) throwDOMException(`文件过大, ${file.size} > ${this.#maxUploadSize}`);

		const safe = (name || file.name).replace(/[\\/:*?"'<>|\r\n]+/g, '_').slice(0, 100) || 'ref';

		const formData = new FormData();
		formData.append('image', new File([file], safe, {type:file.type}));
		formData.append(`subfolder`, `cg-ref`);
		formData.append('type', 'input');

		const data = await jsonFetch(this.#endpoint+'/upload/image', {
			body: formData,
			signal: AbortSignal.timeout(60000),
		});

		return (data.subfolder ? data.subfolder + '/' : '') + data.name;
	}

	/**
	 * 提交并返回可取消带进度回调的任务对象
	 * @param {NodeGraph | Comfy.ApiGraph} prompt
	 * @param {function(Comfy.ApiProgress): void} [onProgress]
	 * @param {boolean} [needPreview]
	 * @return {Promise<{cancel(): Promise<boolean>, done: Promise<Comfy.Artifact[]>}>}
	 */
	async submit(prompt, onProgress, needPreview) {
		if (this.#init) await this.#init;
		if (!this.#ws) throwDOMException("与服务器的连接中断，请重试");
		if (prompt instanceof NodeGraph) prompt = prompt.toJSON();

		clearTimeout(this.#idleTimeout);

		/** @type {string} */
		const taskId = (await jsonFetch(`${this.#endpoint}/prompt`, {
			body: JSON.stringify({ prompt, client_id: this.#client_id, extra_data: { preview_method: needPreview ? 'auto' : undefined } })
		})).prompt_id;

		let cancelProgress;
		const started = this.#started.delete(taskId);
		const progress = {
			_id: taskId,
			status: started ? 'in_progress' : 'pending',
			fin: 0, tot: Object.keys(prompt).length,
			nfin: 0, ntot: 0
		};
		onProgress?.(progress);

		const task = [prompt, onProgress ?? AS_IS, progress];
		if (started) this.#current = task;

		const done = new Promise((resolve, reject) => {
			this.#tasks.set(taskId, task);
			task.push(resolve, reject);
		});
		const onDone = () => cancelProgress = true;
		done.then(onDone, onDone);

		const cancelHandler = p => {
			const wrapped = p.catch(AS_IS).then(r => {
				if (cancelProgress !== wrapped) return cancelProgress;

				if (!this.#ws) task[4](ERR('aborted', 'AbortError'));
				if (!r?.ok) {
					delete progress[CANCEL_IN_PROGRESS];
					cancelProgress = null;
					return false;
				} else {
					return true;
				}
			});
			return wrapped;
		}

		const handle = {
			done,
			cancel: () => {
				if (cancelProgress) return cancelProgress;

				let p;

				if (progress.status === 'pending') {
					// 排队中
					p = fetch(`${this.#endpoint}/api/jobs/${taskId}/cancel`, {
						method: "POST",
					});
					// 考虑网络延迟，请求发送的时候，对面可能已经开始运行任务。在WS收到数据包时补一次
					progress[CANCEL_IN_PROGRESS] = () => {
						// 很少会碰到
						if (cancelProgress === wrapped) {
							cancelProgress = cancelHandler(fetch(`${this.#endpoint}/api/interrupt`, {
								method: "POST",
								body: JSON.stringify({ prompt_id: taskId })
							}));
						}
					};
				} else {
					// 运行中
					p = fetch(`${this.#endpoint}/api/interrupt`, {
						method: "POST",
						body: JSON.stringify({ prompt_id: taskId })
					})
				}

				const wrapped = cancelHandler(p);
				return cancelProgress = wrapped;
			}
		};
		task.push(handle);

		if (!this.#ws) {
			await handle.cancel();
			this.#tasks.delete(taskId);
			throwDOMException("与服务器的连接中断，请重试");
		}

		return handle;
	}

	close() {
		clearTimeout(this.#idleTimeout);
		if (clients[this.#endpoint] === this) {
			delete clients[this.#endpoint];
		}
		for (let value of this.#tasks.values()) value[5].cancel();
		this.#ws?.close();
		this.#ws = null;
	}
}

const clients = Object.create(null);

/**
 * @param {string} server
 * @return {PromptClient}
 */
export const comfy = (server) => clients[server] ??= new PromptClient(server);