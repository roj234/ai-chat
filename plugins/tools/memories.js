import {parseFrontmatter, registerToolset} from "/src/toolset.js";
import {createAsyncQueue} from "../../common/pure-utils.js";
import {fileAccess} from "../agent/index.js";
import {debugSymbol} from "unconscious";

// 提示词是 AI 写的，毕竟这也是给 AI 看的，但代码和设计风格不是。
//
// 相当一部分记忆项目都是文件系统的重新发明。
// 用更复杂、更不透明、更难 debug 的方式做 增删改查
//
// 我承认，这个工具缺失了一部分【自动化】属性，这主要因为AiChat是一个前端应用
// 而根本原因是，我认为在这个软件里，用户应该占主导地位
//
// 它没有很 visual 的“做梦”，“忘却”机制，这些不是 AI，只是对人类的拙劣模仿
// 只要模型能力不太差，能合理的安排文件和关键词，这个设计不会比其他框架差到哪去
// 尽管如此，文件系统在关联搜索上确实有一些先天劣势，但是如果我愿意做工具，也能弥补这些，我之后会做的，比如链接相关文件的工具……
// 嘿，等等，我还不如做符号链接呢，组织相关文件，不就他妈的是文件夹吗？？？
// 把这些交给 AI 很明显对它的能力有更高的要求，它可能无法做到这一点（未证实）
// 但别忘了，这是 AiChat，我刚刚才说【用户应该占主导地位】
//
// 我不会和其他项目一样用一个完全无人工的 README 花上几千几万字说这个项目（在这里是插件）到底牛逼在哪
// 它可能也确实不牛逼，那些无人工的项目没有 benchmark 没有横评只有纯 AI 的夸夸，但可能真的比这个好
// 而且那些项目确实解决了【你不用 AiChat 怎么做记忆】的问题（doge
// 但我不仅没有提供商，我甚至没有软件锁定，1000个token给你90分甚至60分的体验
// 附赠天生支持 namespace、跨平台、零成本、无缝迁移
//
// 那你说这是完全闭门造车吗？
// 不完全是。
// 有论文说 RAG / Vector database 对编码代理是过度设计。
// 为什么？
// 我认为是它黑箱且 Agent 无法从错误中学习。
// 文件系统正好在它的反面。
// 那记忆呢？
// 我试了一下，感觉还行，所以我就端上来了，希望你也喜欢。

const MEMORY_INFO = debugSymbol("Memories");
const glob = fileAccess("list");
const readFile = fileAccess("read");
const readRaw = fileAccess("readRaw");
const binaryWrite = fileAccess("writeRaw");
const mkDir = fileAccess("mkdir");

const copyFile = (name, toBase, conv) => {
	return fetch("files/"+name).then((res) => {
		return res.blob();
	}).then(blob => {
		return binaryWrite({
			path: toBase+name,
			content: blob
		}, 0, conv);
	})
}

async function getMemoryCache(conv) {
	let memoryCache = conv[MEMORY_INFO];
	if (!memoryCache) {
		let prompt = '<memory>\n';

		//const fs = conv.mnt['memory'];

		try {
			prompt += await (await readRaw({path: "~/memory/BOOTSTRAP.md"}, 0, conv)).text() + '\n';
			//delete fs.fs_readonly;
			return prompt + '</memory>';
		} catch {}

		try {
			prompt += await (await readRaw({path: "~/memory/IDENTITY.md"}, 0, conv)).text() + "\n\n"
				+ await (await readRaw({path: "~/memory/USER.md"}, 0, conv)).text() + "\n\n"
				+ await (await readRaw({path: "~/memory/MEMORY.md"}, 0, conv)).text() + "\n\n";
		} catch (e) {
			await Promise.all([
				copyFile("memory/IDENTITY.md", "~/", conv),
				copyFile("memory/USER.md", "~/", conv),
				copyFile("memory/MEMORY.md", "~/", conv),
				copyFile("memory/WRITE_MEMORY.md", "~/", conv),
				copyFile("memory/BOOTSTRAP.md", "~/", conv),
				mkDir({ path: "~/memory/root" }, 0, conv)
			]).catch(() => { throw e; });
			return getMemoryCache(conv);
		}
		prompt += `# Memories (in '~/memory/root/')`;

		const memories = await glob({
			path: "~/memory/root",
			pattern: "*.md",
			json: true
		}, 0, conv);

		const [enqueue, finish] = createAsyncQueue();
		for (const [relPath] of memories) {
			const path = "~/memory/root/"+relPath;
			await enqueue(async () => {
				const str = await readFile({
					path,
					format: 'frontmatter'
				}, 0, conv);

				const [metadata, content, offset] = parseFrontmatter(str);
				const {tags} = metadata;
				prompt += `[${tags.slice(0, 100)}](${relPath})
`;
			});
		}

		await finish();

		if (memories.length > 100)
			prompt += `
There are ${memories} in total, which > 100. You should remove stale entries with user now.`

		return conv[MEMORY_INFO] = prompt + '</memory>';
	}

	return memoryCache;
}

registerToolset("Memories", "人格和长期记忆", [], {
	hidden: 'manual',
	systemPrompt: getMemoryCache,
	depend: ["Files"],
	onActivated(conv) {
		(conv.mnt || (conv.mnt = {}))["memory"] = {
			fs_builtin: true,
			fs_base: "memory",
			fs_name: "长期记忆",
			//fs_readonly: true
		};getMemoryCache(conv);
		return [];
	},
	onDeactivated(conv) {
		const mnt = conv.mnt;
		if (mnt) delete mnt["memory"];
	}
});
