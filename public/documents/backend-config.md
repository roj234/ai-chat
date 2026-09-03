
# 配置文件甚至可以是这样的！

> 这只是我在用的代码，并且可以让 config.js 更好用，不是什么要求

### 从文件加载代理路由

```js
export const SSE_PROXY_BACKEND = AiChatAPI.parseProviderFile("keys.conf");
```

格式示例：
```
# 内联URL
https://opencode.ai/zen/go/v1 ocg sk-123456

# 定义提供商
provider or {
	url: "https://openrouter.ai/api/v1",
	proxy: "socks5://127.0.0.1:10808"
}

# 引用提供商
or openrouter sk-123456
```

### 基于正则表达式的内容审核

```js

const regex = new RegExp(fs.readFileSync("pattern.txt", "utf8").split('\n').map(item=>item.trim()).filter(item=>item&&!item.startsWith("#")).join('|'));

console.log(` [Moderation] Loaded ${regex.toString().length} chars`);

/**
 * 可以async
 * @param {string} url
 * @param {string} apiKey
 * @param {AiChatBackend.RouteContext} ctx
 * @return {void | Object | function(OpenAI.ChatCompletionRequest): Object | void}
 */
export const SSE_PROXY_MODERATION = (url, apiKey, ctx) => {
	// 你也可以在这里直接返回错误
	if (apiKey === 'some-key') return {error: "This key is forbidden"};

	// userId 可能为 null 因为 SSE Proxy 有两个端点 带用户名的和不带的 用户名在 url 里
	const {userId} = ctx.params;
	if (userId !== 'mother') return;
	
	/**
	 *
	 * @param {string} text
	 * @return {{error: string}}
	 */
	const moderation = (text) => {
		if (regex.test(text)) {
			// 如果返回 truthy 值，那么信息不会发送到推理端。
			return {error: "消息中包含敏感个人信息(PII)，请去除后发送"};
		}
	}

	// 你可以检查请求体的其他部分
	return (body) => {
		for (const {content} of body.messages) {
			if (Array.isArray(content)) {
				for (const {type, text} of content) {
					if (type === "text") {
						const result = moderation(text);
						if (result) return result;
					}
				}
			} else {
				return moderation(content);
			}
		}
	};
}
```