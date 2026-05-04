
/**
 * 将 JSON Schema 转换为类 TypeScript 接口的文本格式，以减少 tokens
 * - 然而事实上并没有减少多少 tokens... 希望模型能理解的更清晰吧
 * @param {OpenAI.ObjectSchema} schema
 * @param {boolean} strict
 * @returns {string}
 */
export function schemaToPrompt(schema, strict = true) {
	const tsDefinition = `\`\`\`typescript
${schemaToTS(schema)}
\`\`\``;

	return (strict
		? `### Response format
Respond in valid JSON format strictly conforming to the following TypeScript interface:`
		: `Output only a valid JSON object strictly matching this TypeScript interface. 
Ensure all required fields are present, types are exact, and no extra fields are added. 
No conversational text or markdown outside the JSON.`
	) + "\n\n"+tsDefinition;
}

function schemaToTS(schema) {
	const INDENT = '  ';

	// ==================== 核心: 类型推断 ====================

	function getType(node, depth) {
		if (!node) return 'any';

		// $ref 引用 → 提取类型名
		if (node.$ref) {
			const parts = node.$ref.split('/');
			return parts[parts.length - 1];
		}

		if (node.const != null) return formatLiteral(node.const);
		if (node.enum) return node.enum.map(formatLiteral).join(' | ');

		const type = node.type;

		if (node.oneOf) {
			return node.oneOf.map(item => getType(item, 0)).join(' | ');
		}

		// TODO 实现一些其它的推断 可以参考 llama.cpp 的PEG生成器
		if (!type && node.properties) {
			return renderObject(node, depth);
		}

		// TODO 这里怎么处理
		if (Array.isArray(type)) {
			return type.map(item => primitive(item, node, depth + 1)).join(' | ');
		}

		return primitive(type, node, depth);
	}

	function primitive(type, node, depth) {
		switch (type) {
			case 'string':  return 'string';
			case 'number':  return 'number';
			case 'integer': return 'integer';
			case 'boolean': return 'boolean';
			case 'null':    return 'null';
			case 'object':  return renderObject(node, depth);
			case 'array':   return renderArray(node, depth);
			default:        return 'any';
		}
	}

	function formatLiteral(v) {
		return JSON.stringify(v);
	}

	// ==================== 渲染 ====================

	function renderArray(node, depth) {
		const prop = node.items;
		if (prop) {
			const itemType = getType(prop, depth);

			const lines = renderJSDoc(prop);
			// 造行内注释
			const inlineComment = lines.length ? ` /* ${lines.join('; ')} */` : "";
			return `${itemType}[]${inlineComment}`;
		}
		return 'any[]';
	}

	function renderJSDoc(prop) {
		const annotations = [];

		const {
			description, example,
			minimum = NaN, exclusiveMinimum = NaN,
			maximum = NaN, exclusiveMaximum = NaN,
			multipleOf,
			minLength, maxLength, pattern, format,
			minItems, maxItems, uniqueItems
		} = prop;

		if (description) annotations.push(description);

		if (example) annotations.push(`@example: ${JSON.stringify(example)}`);

		// 数值约束
		let rangePrefix = minimum === minimum ? `>= ${minimum}` : exclusiveMinimum === exclusiveMinimum ? `> ${exclusiveMinimum}` : '';
		let rangeSuffix = maximum === maximum ? `<= ${maximum}` : exclusiveMaximum === exclusiveMaximum ? `< ${exclusiveMaximum}` : '';
		if (rangePrefix && rangeSuffix) {
			// "5 <= x < 10"
			const leftOp = exclusiveMinimum === exclusiveMinimum ? '<' : '<=';
			const rightOp = exclusiveMaximum === exclusiveMaximum ? '<' : '<=';
			const leftVal = minimum || exclusiveMinimum;
			const rightVal = maximum || exclusiveMaximum;
			annotations.push(`@range: ${leftVal} ${leftOp} value ${rightOp} ${rightVal}`);
		} else if (rangePrefix || rangeSuffix) {
			annotations.push(`@range: value ${rangePrefix || rangeSuffix}`);
		}
		if (multipleOf) annotations.push(`@multipleOf: ${multipleOf}`);

		// 字符串约束
		if (minLength || maxLength) {
			const min = minLength ?? 0;
			const max = maxLength ?? 'Infinity';
			annotations.push(`@length: [${min}, ${max}]`);
		}
		if (pattern) annotations.push(`@pattern: ${pattern}`);
		if (format) annotations.push(`@format: ${format}`);

		// 数组约束
		if (minItems || maxItems) {
			const min = minItems ?? 0;
			const max = maxItems ?? 'Infinity';
			annotations.push(`@items: [${min}, ${max}]`);
		}
		if (uniqueItems) annotations.push(`@uniqueItems: true`);

		return annotations;
	}

	function renderField(key, prop, depth, requiredList) {
		const lines = [];
		const optional = requiredList && requiredList.indexOf(key) === -1 ? '?' : '';

		const annotations = renderJSDoc(prop, lines, depth);

		if (annotations.length) {
			if (annotations.length === 1) {
				lines.push(`${pad(depth)}/** ${annotations[0]} */`);
			} else {
				lines.push(`${pad(depth)}/**`);
				lines.push(...annotations.map(line => `${pad(depth)} * ${line}`));
				lines.push(`${pad(depth)} */`);
			}
		}

		lines.push(`${pad(depth)}${key}${optional}: ${getType(prop, depth)};`);
		return lines.join('\n');
	}

	function renderObject(node, depth) {
		const props = node.properties;

		// 无 properties → 检查 additionalProperties (Map 类型)
		if (!props || Object.keys(props).length === 0) {
			if (node.additionalProperties) {
				const valType = getType(node.additionalProperties, depth);
				return `{ [key: string]: ${valType} }`;
			}
			return '{}';
		}

		const required = node.required || [];
		const fields = Object.keys(props).map(k =>
			renderField(k, props[k], depth + 1, required)
		);

		return `{\n${fields.join('\n')}\n${pad(depth)}}`;
	}

	function pad(depth) {
		return INDENT.repeat(depth);
	}

	// ==================== 入口 ====================

	// 顶层 object → 直接输出字段 (LLM 友好的精简格式)
	if (schema.properties && (schema.type === 'object' || !schema.type)) {
		const required = schema.required || [];
		return Object.keys(schema.properties).map(k =>
			renderField(k, schema.properties[k], 0, required)
		).join('\n');
	}

	// 顶层非 object
	return getType(schema, 0);
}
