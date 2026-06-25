import {createMarkdownStream} from "/src/markdown/markdown.js";
import {APIRequest, findStreamingContainer, MARKDOWN_APPEND, MARKDOWN_END} from "/src/api-request.js";
import {$update, AS_IS, isReactive} from "unconscious";
import {updateMessageUI} from "/src/components/MessageList.jsx";
import {abortCompletion, config} from "/src/states.js";
import {bundleModule, createModule} from "unconscious/common/safe-worker/safe-worker.js";
import {ZipReader} from "unconscious/common/zip-io.js";
import {schemaToTypeScriptDefinition} from "unconscious/common/json-schema-utils.js";

export const jsonPrompt = async (schema, messages, body, custom_renderer_id = 'json') => {
	const supportLevel = config.jsonSupport;
	if (supportLevel) {
		body.response_format = supportLevel <= 1
			? { type: "json_object" }
			: {
				type: "json_schema",
				json_schema: {
					name: "schema",
					strict: true,
					schema
				}
			};
	}

	const api = new APIRequest(messages, null, body);

	const removeCodeFence = config.jsonSupport ? AS_IS : s => s.replace(/^\s*```json|```$/, "").trim();

	let markdownRenderer = createMarkdownStream();
	const updateMarkdown = msg => {
		const thinking = isReactive(msg.think);
		const container = findStreamingContainer(thinking);
		if (!container) return true;
		markdownRenderer(thinking ? msg.think.content : `\`\`\`${custom_renderer_id}
` + removeCodeFence(msg.content), container);
	};

	api.abort = abortCompletion;
	try {
		const [message, log] = await api.call(null, (type, content) => {
			switch (type) {
				case MARKDOWN_APPEND:
					if (updateMarkdown(content)) break;
					return;
				case MARKDOWN_END:
					markdownRenderer();
			}
			$update(updateMessageUI);
		});

		message.content = removeCodeFence(message.content);

		/*log.id = -1;
		log._type = "jsonApi/"+custom_renderer_id;
		await appendBillingLog(log);*/

		return message;
	} finally {
		abortCompletion.value = null;
	}
};

const RPGCore = {
	schemaToTypeScriptDefinition
};

const systemModule = new Map;
systemModule.set("/plugins/rpg/pipeline.js", { module: RPGCore });

class Sandbox {
	instance;

	constructor(code) {
		this.code = code;
	}

	async call(method, ...args) {
		if (!this.instance) {
			this.instance = createModule(systemModule, null, this.code);
			await this.instance.ready;
		}

		let t;
		const result = this.instance.module[method](args);
		const timeout = new Promise((_, reject) => {
			t = setTimeout(() => {
				reject(new Error("脚本执行超时 (5s)"));
				this.instance.destroy();
				this.instance = null;
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
		try {
			// 动态导入，Vite 会处理成 /@fs/... 或正确的 URL
			this.module = await import(/* @vite-ignore */ this.modulePath);
		} catch (e) {
			// 如果第一次导入失败，尝试添加 ?t= 以绕过缓存
			this.module = await import(`${this.modulePath}?t=${Date.now()}`);
		}
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

export const createSandboxEnvironment = async (archive) => {
	const archiveModule = new Map(systemModule);
	if (typeof archive === 'string') {
		archiveModule.set("script.js", { code: archive });
	} else {
		const zip = await ZipReader(archive);
		for (let [name, entry] of zip.entries()) {
			if (entry.uncompressedSize < 1048576)
				archiveModule.set(name, { code: await zip.getText(entry) });
		}
	}

	const code = bundleModule(archiveModule, 'script.js');
	return new Sandbox(code);
}

export const createDevelopEnvironment = async (modulePath) => {
	return new Develop(modulePath);
}
