import {getToolParameters, parseFrontmatter, registerToolset} from "/src/toolset.js";
import {debugSymbol} from "unconscious";
import {fileAccess} from "./fileAccess.js";
import skillDescription from './skill-description.md?raw';

const SKILL_CACHE = debugSymbol("SkillCache");
const glob = fileAccess("list");
const readFile = fileAccess("read");
const writeFile = fileAccess("write");
const statFile = fileAccess("stat");


/**
 * @type {AiChat.FunctionTool}
 */
const Skill = {
	name: "Skill",
	description: `Read one skill's content.
When users ask you to perform tasks, check if any of the available skills match and invoke Skill tool.
Skills provide specialized capabilities and domain knowledge.`,
	parameters: {
		type: "object",
		properties: {
			name: { type: "string", }
		},
		required: ["name"]
	},
	async script({name}, a, conv) {
		const cache = (await initSkillCache(conv)).index;
		const [path, offset] = cache[name] || [];
		if (!path) {
			throw 'Skill not found.\nNote: To avoid cache miss, new skills are not loaded automatically, create a new session or reload current session to flush skills.'
		}

		const str = await readFile({
			path,
			offset,
			noTruncate: true
		}, {}, conv);

		return "Path: "+path+"\n\n---\n\n"+str;
	},
	title(req, ctx) {
		const skill = getToolParameters(ctx, req).name;
		return "激活技能 "+skill;
	}
}

async function initSkillCache(conv) {
	let skillCache = conv[SKILL_CACHE];
	if (!skillCache) {
		const index = {};
		let prompt = `<skills>
Available skills:
---
`;

		const skills = await glob({
			path: "~/.skills",
			pattern: "*/SKILL.md", // */**/SKILL.md
			json: true
		}, 0, conv);

		for (const [relPath, type] of skills) {
			const path = "~/.skills/"+relPath;
			const str = await readFile({
				path,
				format: 'frontmatter'
			}, {}, conv);
			const [metadata, content, offset] = parseFrontmatter(str);
			if (!('name' in metadata)) continue;
			if (metadata.xAiChatShellOnly && conv.fs_type !== 'api') continue;

			index[metadata.name] = [path, offset];
			if (!metadata.disableModelInvocation)
				prompt += metadata.name+":\n"+metadata.description+"\n\n";
		}

		return conv[SKILL_CACHE] = {
			index,
			prompt: prompt + '</skills>'
		};
	}

	return skillCache;
}

registerToolset("Skills", "技能（挂载点 + 提示词）", [Skill], {
	hidden: 'manual',
	//default: true,
	async systemPrompt(conv) {
		let prompt = (await initSkillCache(conv)).prompt;
		if (conv.activatedModules.has("Files")) {
			try {
				await statFile( {
					path: "~/.skills/CONTRIBUTING.md"
				}, 0, conv);
			} catch {
				await writeFile({
					path: "~/.skills/CONTRIBUTING.md",
					content: skillDescription
				}, 0, conv);
			}

			prompt = "<skills>\nRead '~/.skills/CONTRIBUTING.md' before create or modify skills."+prompt.slice(8);
		}
		return prompt;
	},
	//depend: ["Files"],
	onActivated(conv) {
		(conv.mnt || (conv.mnt = {}))[".skills"] = {
			fs_builtin: true,
			fs_base: "skills",
			fs_name: "技能目录"
		};
		return [Skill];
	},
	onDeactivated(conv) {
		const mnt = conv.mnt;
		if (mnt) delete mnt[".skills"];
	}
});
