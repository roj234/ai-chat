/**
 * 将 JSON Schema 转换为 TypeScript 风格的类型定义字符串
 * @param {OpenAI.Schema} schema - JSON Schema 对象
 * @param {string} typeName - 根类型的名称
 * @param {number} indentSize - 缩进空格数
 * @returns {string}
 */
export function schemaToTypeDef(schema, typeName, indentSize = 0) {
	console.assert(!typeName || schema.type === "object");

	const indent = " ".repeat(indentSize);

	// 1. 处理基础常量或枚举
	if (schema.const !== undefined) {
		return `${JSON.stringify(schema.const)}`;
	}
	if (schema.enum) {
		return schema.enum.map(v => JSON.stringify(v)).join(" | ");
	}

	// 2. 处理 oneOf / anyOf
	if (schema.oneOf || schema.anyOf) {
		const list = schema.oneOf || schema.anyOf;
		return list.map(sub => schemaToTypeDef(sub, "", indentSize)).join(" | ");
	}

	// 3. 处理核心类型
	switch (schema.type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "value": // 处理你 schema 中自定义的 "value" 类型
			return "any";

		case "array":
			const itemType = schema.items
				? schemaToTypeDef(schema.items, "", indentSize)
				: "any";
			return `Array<${itemType}>`;

		case "object":
			if (!schema.properties) return "Record<string, any>";

			const props = Object.entries(schema.properties).map(([key, propSchema]) => {
				const isRequired = schema.required && schema.required.includes(key);
				const propComment = propSchema.description ? `  // ${propSchema.description}` : "";
				const nestedType = schemaToTypeDef(propSchema, "", indentSize + 2);

				return `${indent}  ${key}${isRequired ? "" : "?"}: ${nestedType};${propComment}`;
			});

			const header = typeName ? `type ${typeName} = ` : "";
			return `${header}{\n${props.join("\n")}\n${indent}}`;

		default:
			return "any";
	}
}