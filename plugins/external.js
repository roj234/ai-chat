/**
 *
 * @type {OpenAI.Tool}
 * @private
 */
const search = {
	"name": "search",
	"description": "在向量数据库中搜索相关资料",

	"parameters": {
		"type": "object",
		"properties": {
			"search": {
				"type": "string",
				"description": "用于生成 embedding query 的字符串",
			},
			"count": {
				"type": "number",
				"description": "返回多少数据，最大不超过50"
			},
		},
		"required": ["search"]
	}
};
const search_save = {
	"name": "search_save",
	"description": "在向量数据库中写入资料",

	"parameters": {
		"type": "object",
		"properties": {
			"text": {
				"type": "string",
				"description": "用于生成 embedding query 的字符串",
			},
		},
		"required": ["text"]
	}
};
