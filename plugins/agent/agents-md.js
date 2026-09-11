import {parseFrontmatter, PLACEHOLDERS, setPlaceholder} from "/src/toolset.js";
import {fileAccess} from "./Mounts.js";
import {getSkillCache} from "./skills.js";

const readFile = fileAccess("read");

PLACEHOLDERS["#AGENTS.md"] = async (conv) => {
	if (!conv.activatedModules?.has("Files")) return '';//'Workspace: disabled, click "智能体" button to enable.';

	let text = '';

	try {
		text = await readFile({ path: "AGENTS.md", noTruncate: true }, null, conv);
	} catch {}

	if (text) {
		const [info, content] = parseFrontmatter(text);

		let tag = 'project-context';
		while (text.includes(`<${tag}>`)) {
			tag += Math.random().toString(36)[3];
		}

		text = `<${tag}>
# Project context (from AGENTS.md)

${content}
</${tag}>`;

		let skills = info.skills;
		if (skills) {
			const index = conv.mnt?.[".skills"] && (await getSkillCache(conv)).index;
			if (typeof skills === 'string') skills = skills.split(" ");

			const includes = (await Promise.all(skills.map(path => readFile({
				path: index?.[path]?.[0] ?? path,
				noTruncate: true
			}, null, conv).then(text => `# Document ${path}\n\n`+text)))).join('\n\n');

			text += "\n\n"+includes;
		}
	}

	return setPlaceholder(conv, "#AGENTS.md", text);
};