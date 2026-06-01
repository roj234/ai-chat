

## 配置文件

### 从文件加载代理路由

```js

import fs from 'node:fs';

/**
 * SSE 后端代理路由表
 *
 * 匹配逻辑：
 * 1. 匹配 Header 中的 Authorization (Bearer 后面的 Key)。
 * 2. 若匹配成功，则转发至对应的 url 并覆盖 authorization。
 * 3. 若未匹配，则尝试使用 'default' 配置。
 * 4. 若 'default' 未定义 authorization，则执行 BYOK (Bring Your Own Key) 模式。
 * 5. 无匹配项且无 default 时返回 403。
 */
export const SSE_PROXY_BACKEND = {};

fs.readFileSync("keys.txt", "utf8").split('\n').map(item=>item.trim()).filter(item=>item&&!item.startsWith("#")).forEach(item => {
	const {username,password,origin,pathname} = new URL(item);
	SSE_PROXY_BACKEND[username] = {
		url: origin+pathname,
		authorization: password
	};
	console.log(` [ApiKey] Loaded key '${username}' (****${password.slice(-4)}) on ${origin}`);
});
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