import {getToolParameters, parseFrontmatter, registerToolset} from "/src/toolset.js";
import {debugSymbol} from "unconscious";
import {fileAccess} from "./Mounts.js";
import {createAsyncQueue} from "/common/pure-utils.js";
import agentDescription from "/media/vfs/skills/agent-definition-howto/SKILL.md?raw";
import skillDescription from "/media/vfs/skills/write-skill-howto/SKILL.md?raw";
import {EVENT_BUS} from "/src/states.js";

const SKILL_INFO = debugSymbol("Skills");
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
		const cache = (await getSkillCache(conv)).index;
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

export async function getSkillCache(conv) {
	let skillCache = conv[SKILL_INFO];
	if (!skillCache) {
		const index = {};
		let prompt = `<skills>\n`;

		if (conv.activatedModules.has("Files")) {
			// TODO zip vfs for it
			const path = "~/.skills/write-skill-howto/SKILL.md";
			try {
				await statFile( {
					path
				}, 0, conv);
			} catch {
				await Promise.all([
					writeFile({
						path,
						content: skillDescription
					}, 0, conv),
					writeFile({
						path: "~/.skills/agent-definition-howto/SKILL.md",
						content: agentDescription
					}, 0, conv),
					EVENT_BUS.post(['initSkills'], conv, writeFile)
				]);
			}
		}

		prompt += `Available skills:\n---\n`;

		const skills = await glob({
			path: "~/.skills",
			pattern: "*/SKILL.md", // */**/SKILL.md
			json: true
		}, 0, conv);

		const sortable = [];
		const [enqueue, finish] = createAsyncQueue();
		for (const [relPath, type] of skills) {
			const path = "~/.skills/"+relPath;
			await enqueue(async () => {
				const str = await readFile({
					path,
					format: 'frontmatter'
				}, {}, conv);
				const [metadata, content, offset] = parseFrontmatter(str);
				if (!('name' in metadata)) return;
				if (metadata.xAiChatShellOnly && conv.fs_type !== 'api') return;
				index[metadata.name] = [path, offset];

				if (!metadata.disableModelInvocation)
					sortable.push(metadata)
			});
		}

		await finish();

		const intl = new Intl.Collator;
		sortable.sort((a, b) => intl.compare(a.name, b.name)).forEach(metadata => {
			prompt += metadata.name+":\n"+metadata.description+"\n\n";
		});

		return conv[SKILL_INFO] = {
			index,
			prompt: prompt + '</skills>'
		};
	}

	return skillCache;
}

registerToolset("Skills", "技能", [Skill], {
	hidden: 'manual',
	//default: true,
	async systemPrompt(conv) {
		return (await getSkillCache(conv)).prompt;
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
