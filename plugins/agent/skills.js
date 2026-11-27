import {getToolParameters, parseFrontmatter, registerToolset} from "/src/toolset.js";
import {debugSymbol} from "unconscious";
import {fileAccess} from "./Mounts.js";
import {createAsyncQueue, stringCompare} from "/common/pure-utils.js";
import {EVENT_BUS} from "/src/states.js";
import {PLACEHOLDERS} from "/src/utils/placeholder.js";

const SKILL_INFO = debugSymbol("Skills");
const glob = fileAccess("list");
const readFile = fileAccess("read");
const writeFile = fileAccess("write");
const writeBinary = fileAccess("writeRaw");
const deleteFile = fileAccess("delete");

PLACEHOLDERS['skill'] = async (conv, name) => {
	const cache = (await getSkillCache(conv)).index;
	const arr = cache[name];
	if (!arr) throw `找不到技能 ${name}. 如果它是刚写的，请刷新页面。`;

	let [path, offset, str] = arr;

	if (null == str) {
		arr[2] = str = await readFile({
			path,
			offset,
			noTruncate: true
		}, {}, conv);
	}

	return str;
}

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
		const arr = cache[name];
		if (!arr) throw `Skill ${name} not found.
Note: To avoid cache miss, new skills are not loaded automatically, create a new session or reload current session to flush skills.`
		let [path, offset, str] = arr;

		if (null == str) {
			arr[2] = str = await readFile({
				path,
				offset,
				noTruncate: true
			}, {}, conv);
		}

		return "Path: "+path+"\n\n---\n\n"+str;
	},
	title(req, ctx) {
		const skill = getToolParameters(ctx, req).name;
		return "激活技能 "+skill;
	}
}

const copyFile = (name, toBase, conv) => {
	return fetch("files/"+name).then((res) => {
		return res.blob();
	}).then(blob => {
		return writeBinary({
			path: toBase+name,
			content: blob
		}, 0, conv);
	})
}

const SKILL_VERSION = "2";
const nothing = {};

EVENT_BUS.on('convCacheClear', (conv) => { delete conv[SKILL_INFO]; });
export async function getSkillCache(conv) {
	let skillCache = conv[SKILL_INFO];
	if (!skillCache) {
		const index = {};
		let prompt = `<skills>\n`;

		if (conv.mnt?.skills) {
			const path = "~/skills/.aint-skill-version";
			try {
				const version = await readFile( {
					path,
					limit: 1,
					noTruncate: true,
				}, 0, conv);
				if (version !== SKILL_VERSION) throw '';
			} catch {
				const aintSkills = await glob({
					path: "~/skills",
					pattern: "aint-*",
					json: true
				}, nothing, conv);

				const fs = conv.mnt.skills;
				fs.fs_readonly = false;

				await Promise.allSettled(aintSkills.map(data => deleteFile({path: "~/skills/"+data[0]}, nothing, conv)));

				const p = Promise.all([
					copyFile("aint-skills/SKILL.md", "~/skills/", conv),
					copyFile("aint-agents/SKILL.md", "~/skills/", conv),
					copyFile("aint-agents/ACL.md", "~/skills/", conv),
					copyFile("aint-ptc/SKILL.md", "~/skills/", conv),
					copyFile("aint-wait/SKILL.md", "~/skills/", conv),
					copyFile("aint-wait/watch-window.js", "~/skills/", conv),
					writeFile({ path: "~/skills/.aint-skill-version", content: SKILL_VERSION, overwrite: true }, nothing, conv),
					EVENT_BUS.post(['initSkills'], conv, writeFile)
				]);
				p.finally(() => fs.fs_readonly = true);
				await p;
			}
		}

		prompt += `Available skills:\n---\n`;

		const skills = await glob({
			path: "~/skills",
			pattern: "*/SKILL.md",
			json: true
		}, nothing, conv);

		const sortable = [];
		const [enqueue, finish] = createAsyncQueue();
		for (const [relPath] of skills) {
			const path = "~/skills/"+relPath;
			await enqueue(async () => {
				const str = await readFile({
					path,
					format: 'frontmatter'
				}, nothing, conv);
				const [metadata, content, offset] = parseFrontmatter(str);
				if (!('name' in metadata)) return;
				if (metadata.xAiChatShellOnly && conv.fs_type !== 'api') return;
				index[metadata.name] = [path, offset];

				if (!metadata.disableModelInvocation)
					sortable.push(metadata)
			});
		}

		await finish();

		sortable.sort((a, b) => stringCompare(a.name, b.name)).forEach(metadata => {
			prompt += metadata.name+":\n"+metadata.description+"\n\n";
		});

		return conv[SKILL_INFO] = {
			index,
			prompt: prompt + '</skills>'
		};
	}

	return skillCache;
}

registerToolset("Skills", "技能\n让模型按任务加载对应的操作指南。", [Skill], {
	default: true,
	async systemPrompt(conv) {
		return (await getSkillCache(conv)).prompt;
	},
	onActivated(conv) {
		(conv.mnt || (conv.mnt = {}))["skills"] = {
			fs_builtin: true,
			fs_base: "skills",
			fs_name: "技能目录",
			fs_readonly: true
		};
		return [Skill];
	},
	onDeactivated(conv) {
		const mnt = conv.mnt;
		if (mnt) delete mnt["skills"];
	}
});
