/**
 * 模板格式化器（JavaScript ES6 class 版本）
 *
 * 语法：
 *   {{name}}          - 变量引用，env 中必须有此键，否则抛错
 *   {{name|default}}  - 带默认值的变量引用，缺键时用 default（字面输出，原样保留引号等字符）
 *
 * 示例：
 *   const f = TemplateFormatter.compile('"steps": {{steps|25}}, "name": {{name}}');
 *   f.format({ name: 'foo' });            // → '"steps": 25, "name": "foo"'
 *   f.format({ steps: 30, name: 'bar' }); // → '"steps": 30, "name": "bar"'
 *   f.format({ steps: 30 });              // 抛错：缺少变量 name
 */
export class TemplateFormatter {
	/**
	 * @param {string} template
	 */
	constructor(template) {
		/** @type {Array<string | {name:string, default:string}>} */
		this.parts = [];
		this._constant = true;
		this._parse(template);
	}

	/**
	 * @param {string} template
	 * @private
	 */
	_parse(template) {
		let prevI = 0;
		while (true) {
			const i = template.indexOf('{{', prevI);
			if (i < 0) break;

			const end = template.indexOf('}}', i + 2);
			if (end < 0) throw new Error(`未闭合的花括号(${i}): ${template}`);

			if (i > prevI) this.parts.push(template.slice(prevI, i));

			// 解析 name 和 default
			const content = template.slice(i + 2, end);
			const pipeIdx = content.indexOf('|');

			let name, defaultVal = null;
			if (pipeIdx >= 0) {
				name = content.slice(0, pipeIdx).trim();
				defaultVal = content.slice(pipeIdx + 1); // 默认值原样保留（包括引号、空格）
			} else {
				name = content.trim();
			}

			if (!name) throw new Error(`非法变量名(${i}): ${content}`);

			this.parts.push({ name, default: defaultVal });
			this._constant = false;

			prevI = end + 2;
		}

		if (prevI < template.length) this.parts.push(template.slice(prevI));
	}

	/**
	 * 用 env 中的值填充模板并返回字符串
	 * @param {Record<string, any>} env
	 * @returns {string}
	 * @throws {Error} 当变量缺失且没有默认值时
	 */
	format(env) {
		if (this._constant) return this.parts[0] ?? '';

		let out = '';
		for (const part of this.parts) {
			if (typeof part === "string") { out += part; continue; }

			const has = Object.prototype.hasOwnProperty.call(env, part.name);
			let val = has ? env[part.name] : undefined;

			if (val == null) {
				val = has ? 'null' : part.default;
				if (val == null) throw new Error(`缺少变量: ${part.name}`);
			} else if (val instanceof TemplateFormatter) {
				out += val.format(env);
			} else if (typeof val === 'function') {
				const r = val(env);
				out += r === undefined ? '' : r;
			} else {
				out += val;
			}
		}
		return out;
	}

	/** 是否为常量模板（不含任何变量） */
	isConstant() {
		return this._constant;
	}

	/** 预编译入口 */
	static compile(template) {
		return new TemplateFormatter(template);
	}

	/** 一次性使用：编译 + 格式化 */
	static format(template, env) {
		return new TemplateFormatter(template).format(env);
	}
}
