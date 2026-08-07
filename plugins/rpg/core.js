import {agentLoop} from "/src/api-request.js";
import {$stampLock, unconscious} from "unconscious";
import {config, selectedConversation} from "/src/states.js";
import {createSandbox} from "unconscious/common/safe-worker/safe-worker.js";
import {ZipReader} from "unconscious/common/zip-io.js";
import {schemaToTypeScriptDefinition} from "unconscious/common/json-schema-utils.js";

export {USER_PROMPT} from "/common/ReactiveJSON.js";

export const runSchemaRole = async (role, schema, messages, overrides) => {
	const conv = unconscious(selectedConversation);
	const msgs = $stampLock(messages);
	const conf = unconscious(config);

	let additionalBody = conf.additionalBody;

	const jsonSupport = conf.jsonSupport;
	if (jsonSupport) {
		additionalBody = {
			...additionalBody,
			response_format: jsonSupport <= 1
				? { type: "json_object" }
				: {
					type: "json_schema",
					json_schema: {
						name: role,
						strict: true,
						schema
					}
				}
		}
	}

	conv.roleId = role;

	return agentLoop(conv, msgs, {
		// 禁止调用工具
		disableTools: true,
		...overrides,
		// 必须是JSON
		additionalBody
	});
};

const RPGCore = {
	schemaToTypeScriptDefinition
};

const systemModule = new Map;
systemModule.set("/plugins/rpg/pipeline.js", RPGCore);

class Sandbox {
	#sandbox;
	#repo;
	#module;

	constructor(data) {
		this.#repo = data;
	}

	async call(method, ...args) {
		if (!this.#sandbox) {
			const repo = this.#repo;
			this.#sandbox = createSandbox({
				async load(name, isSystemModule) {
					if (typeof repo === 'string') {
						if (name === 'index.js') return repo;
					} else {
						const code = await repo.getText(name);
						if (code) return code;
					}

					throw new Error(`Module ${name} not found`);
				},
				log() {

				}
			}, [], {
				hostModules: systemModule
			});
			await this.#sandbox.initialize();
			this.#module = await this.#sandbox.loadModule('index.js');
		}

		let t;
		const result = this.#module[method](args);
		const timeout = new Promise((_, reject) => {
			t = setTimeout(() => {
				const err = new Error("脚本执行超时 (5s)");
				reject(err);
				this.#sandbox.destroy(err);
				this.#sandbox = null;
			}, 5000);
		});
		result.finally(() => clearTimeout(t));
		return Promise.race([result, timeout]);
	}
}

class Develop {
	module;

	constructor(modulePath) {
		this.modulePath = modulePath;
	}

	async ready() {
		if (this.module) return this.module;
		// 动态导入，Vite 会处理成 /@fs/... 或正确的 URL
		this.module = await import(/* @vite-ignore */ this.modulePath);
		return this.module;
	}

	async call(method, ...args) {
		await this.ready();
		if (typeof this.module[method] !== 'function') {
			throw new Error(`模块未导出方法: ${method}`);
		}
		return await this.module[method](...args);
	}
}

export const createSandboxEnvironment = async (archive) => new Sandbox(typeof archive === 'string' ? archive : await ZipReader(archive));
export const createDevelopEnvironment = async (modulePath) => new Develop(modulePath);
