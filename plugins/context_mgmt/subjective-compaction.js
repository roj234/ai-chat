import {getToolParameters, registerToolset} from "/src/toolset.js"
import {config, MessageRoles, messages, onConversationLoaded, selectedConversation} from "/src/states.js"
import {COMMAND_REGISTRY} from "/src/commands.js"
import {showToast} from "/src/components/Toast.js"
import {unconscious} from "unconscious"
import {enableBranches, expandFolds} from "/src/utils/BranchManager.js";
import {getImmediateMessages, getMessages,} from "/src/database.js";
import {serializeJSON} from "/src/utils/serialization.js";
import {createFileSystemAsync, VirtualDirectory, VirtualFile} from "../agent/index.js";
import {FSE_NotFound, throwDOMException} from "/common/pure-utils.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {createWebFileSystem} from "../agent/WebFSDriver.js";

const ID = "ContextCompression";

/**
 * @param {AiChat.Conversation} conv
 */
const getState = conv => (conv[ID] ??= {
	tokensSaved: 0,
	manual: false,
	nudgeCounter: 0,
});

const pad3 = n => String(n).padStart(3, '0')

function computeIds(path) {
	const idMap = new Map();

	let seq = 1;
	let started = false;
	let nextGroup = 1;

	for (let i = 0; i < path.length; i++) {
		const m = path[i];

		if (!started) {
			if (MessageRoles[m.role]?.preprocess) continue;
			started = true;
		}

		if (m.role === 'fold') {
			idMap.set(m.group, i);
			seq += m.end - m.start + 1;

			const n = parseInt(m.group.slice(1), 10);
			if (n >= nextGroup) nextGroup = n + 1;
		} else {
			idMap.set("m" + pad3(seq), i);
			seq++;
		}
	}
	return {idMap, nextGroup};
}

/** @type {AiChat.FunctionTool} */
const Compress = {
	name: "Compress",
	description: `Collapse one or more conversation ranges into detailed summaries.
Include multiple independent ranges as separate entries in \`ranges\` array.`,
	parameters: {
		type: "object",
		properties: {
			topic: {
				type: "string",
				description: "Short label (3-5 words) — e.g. 'Auth System Exploration'"
			},
			ranges: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					properties: {
						startId: {
							type: "string",
							description: "Message ID marking start (e.g. m001, b2)"
						},
						endId: {
							type: "string",
							description: "Message ID marking end (e.g. m042, b5)"
						},
						summary: {
							type: "string",
							description: "Exhaustive technical summary capturing file paths, function signatures, decisions, constraints, findings. This is an authoritative record — the original conversation should add no value after compression."
						}
					},
					required: ["startId", "endId", "summary"]
				}
			}
		},
		required: ["topic", "ranges"]
	},

	async script(params, response, conv) {
		const state = getState(conv);

		const path = expandFolds(await getMessages(conv));
		let {idMap, nextGroup} = computeIds(path);

		const topic = params.topic;
		const resolved = [];

		for (const range of params.ranges) {
			const { startId, endId } = range;

			const startIdx = idMap.get(startId);
			if (startIdx == null) throw `Invalid or unknown message/block for startId: ${startId}`;
			const endIdx = idMap.get(endId);
			if (endIdx == null) throw `Invalid or unknown message/block for endId: ${endId}`;

			if (startIdx > endIdx) throw `startId (${startId}) must appear before endId (${endId})`;

			let removed = 0;
			for (let i = startIdx; i <= endIdx; i++) removed += JSON.stringify(path[i]).length;

			resolved.push({
				startIdx,
				endIdx,
				tokensSaved: removed / 4,
				summary: range.summary.replace(/\((b[^)]+)\)/g, (match, idStr) => {
					const block = path.find(m => m.role === 'fold' && m.group === idStr)
					if (!block) return match
					return `[Previously compressed: ${block.topic ?? idStr}]\n${block.content ?? ''}`
				}),
			})
		}

		const ordered = resolved.sort((a, b) => a.startIdx - b.startIdx);
		for (let i = 1; i < ordered.length; i++) {
			if (ordered[i].startIdx <= ordered[i - 1].endIdx)
				throw `Overlapping ranges in one Compress call: ` +
					`#${ordered[i - 1].startIdx}-#${ordered[i - 1].endIdx} and #${ordered[i].startIdx}-#${ordered[i].endIdx}`
		}

		for (const r of ordered) {
			state.tokensSaved += r.tokensSaved;
		}

		ordered.reverse();

		nextGroup += ordered.length;

		const bm = enableBranches(conv);
		const newIds = [];
		for (const { startIdx, endIdx, summary } of ordered) {
			const groupId = "b" + --nextGroup;

			bm.fold(startIdx, startIdx, {
				//foldRole: "user",
				topic,
				time: Date.now(),
				content: summary,
			}, groupId);

			newIds.push(groupId);
		}

		response.blockIds = newIds;
		return `OK`;
	},
	undo(resp, conv) {
		const blockIds = resp.blockIds;
		if (!blockIds?.length) return;

		const bm = getImmediateMessages(conv);
		for (let i = blockIds.length - 1; i >= 0; i--) {
			const block = bm.find(m => m.role === 'fold' && m.group === blockIds[i]);
			if (block) bm.unfold(block);
		}
	},

	title(req, resp) {
		const args = getToolParameters(resp, req);
		return `压缩: ${args.topic} `+resp.blockIds;
	}
};

// 这只是个占位符，别想着模型会主动调用它
const Marker = {
	name: "Marker",
	description: `Place a bookmark in the conversation. Use this at meaningful boundaries so you can later reference exact positions when compressing with the compress tool.`,
	script() {return '\0'},
	title() {return `📌`}
}


const convMessageHandler = {
	async read(data) {
		return serializeJSON(data, 2);
	},
}

const MxxVFSRoot = new NestedMap();
MxxVFSRoot.set([".handlers", 1], {
	async file(name, create, self) {
		const conv = self.path.at(-1);
		const path = expandFolds(await getMessages(conv), true);
		let {idMap} = computeIds(path);

		const i = idMap.get(name.slice(0, -5));
		if (i == null) throwDOMException(name, FSE_NotFound);
		return new VirtualFile(convMessageHandler, path[i]);
	},
	async *entries(self) {
		const conv = self.path.at(-1);
		const path = expandFolds(await getMessages(conv), true);
		let {idMap} = computeIds(path);

		for (const [k, v] of idMap.entries()) {
			yield [k+".json", {
				kind: "file",
				getFile() {
					return {
						size: path[v].content.length || -1,
						lastModified: path[v].time || 0
					}
				}
			}];
		}
	},
});

/*PROMPT_TEMPLATES['[DCP] 让模型主动查上下文'] = `\n{{dcp:hint1}}`;
PLACEHOLDERS['dcp:hint1'] = (conv) => {
	if (conv.activatedModules?.has(ID)) {
		return `
- All context stays inside \`~/.history/\` (\`mNNN.json\` per message).
  Read/Grep there to recall exact sources when a summary is insufficient.
`
	}

	return '';
};*/

registerToolset(ID, "主动上下文管理\n使用 /dcp ui 打开配置界面", [Compress, Marker], {
	hidden: 'manual',
	systemPrompt: `<context-management>
Use \`Compress\` tool to replace stale conversation ranges with dense summaries.

## Philosophy
Compression crystallizes raw exploration into refined understanding. Summary becomes the authoritative record.

## When to Compress
- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded

## When NOT to Compress
- Raw context still needed for edits or precise references
- Content still actively in progress
- May need exact code, error messages, or file contents next

## Operating Stance
- Prefer smaller, regular compressions over infrequent massive ones
- Batch independent ranges in a single Compress call
- Evaluate conversation signal-to-noise REGULARLY

## Compressed Block Placeholders
When the range includes previously compressed blocks, use \`(bN)\` placeholder:
- \`(bN)\` — reserved token, will be expanded to full block content
- Do NOT invent \`(bN)\` for blocks outside the selected range
- For prose mentions use "compressed bN" (not parenthesized)

## Boundary IDs
Each user message has \`<marker>mNNN</marker>\` at its end — use these IDs:
- \`mNNN\`: raw message (e.g. m001, m042)
- \`bN\`: previously compressed block (e.g. b1, b3)
- startId must appear before endId in conversation
- Do NOT invent IDs — use only visible ones

## Summary Quality
- EXHAUSTIVE: capture file paths, function signatures, decisions, constraints
- User intent fidelity: preserve exact user intent, prefer direct quotes
- Lean: strip failed attempts, verbose outputs, dead-end exploration

## After Compress
- The call itself is removed and replaced by a short \`<context-compressed>\` receipt. It is a record of the system's action, not something you wrote — seeing it is normal and means the call succeeded; it never means the call was lost.
- Each compressed span becomes a \`<context-summary id="bN">\` block placed where that span used to be.
- Old ids inside a compressed span are no longer addressable. Use the \`bN\` of the checkpoint instead.
- All context stays inside \`~/.history/\` (\`mNNN.json\` per message), nothing is physically deleted.

It is our responsibility to keep a sharp, high-quality context window.
</context-management>`,
	onActivated(conv) {
		const msgs = unconscious(messages);
		if (!msgs.some(m => m.role === ID)) {
			registerSelf(msgs, conv);
		}

		return [Compress, Marker]
	},
	onDeactivated(conv) {
		const msgs = unconscious(messages)
		for (let i = 0; i < msgs.length; i++) {
			if (msgs[i].role === ID) {
				msgs.splice(i, 1);
				delete conv.mnt?.['.history'];
				break;
			}
		}
	}
})

function registerSelf(messages, conv) {
	messages.unshift({
		role: ID,
		id: -1,
		hidden: true,
	});

	const instance = {};
	createFileSystemAsync(instance, createWebFileSystem(new VirtualDirectory(MxxVFSRoot, [".", "sessions", conv], MxxVFSRoot.getChildren([".handlers", 1]))));
	(conv.mnt ??= {})['.history'] = instance;
}

onConversationLoaded((conv, path, messages) => {
	if (conv.activatedModules?.has(ID) && !messages.some(m => m.role === ID)) {
		registerSelf(messages, conv);
	}
});

MessageRoles[ID] = {
	preprocess(self, messages, conv) {
		const state = getState(conv);
		if (!state) return;

		const output = messages.map(m => ({...m}));

		let seq = 1;

		for (let i = 0; i < output.length; i++) {
			const m = output[i];
			const role = m.role;
			if (role === 'system') continue;

 			const messageId = "m"+String(seq).padStart(3, '0');
			let compressionCalls = [];

			if (role === 'user') {
				const marker = `\n\n<marker>${messageId}</marker>`;
				const cnt = m.content;
				if (typeof cnt === "string") {
					m.content = cnt + marker;
				} else if (Array.isArray(cnt)) {
					const last = cnt.at(-1);
					if (last.type === 'text') {
						m.content = [...cnt.slice(0, -1), {...last, text: last.text + marker}];
					} else {
						m.content = [...cnt, {type: "text", text: marker}];
					}
				}
			} else if (role === 'assistant') {
				let tools = m.tool_calls;

				if (tools) {
					m.tool_calls = tools = [...tools];
					const tr = m.tool_responses = [...(m.tool_responses || [])];

					for (let j = tools.length - 1; j >= 0; j--) {
						const tc = tools[j];
						const name = tc.function.name;
						if (name === 'Compress' || name === 'Marker') {
							if (name === 'Compress') {
								const result = tr[j];
								if (result?.success !== true) continue;
								compressionCalls.push([getToolParameters(result, tc), result]);
							}
							tools.splice(j, 1);
							tr.splice(j, 1);
						}
					}

					if (!compressionCalls.length) {
						tools.push({
							id: "Marker_" + seq,
							type: 'function',
							function: {
								name: "Marker",
								arguments: "{}"
							}
						});
						tr.push({success: true, content: `${messageId}`});
					}

					if (!tools.length) {
						delete m.tool_calls;
					}

					if (!m.content && !tools.length) {
						output.splice(i--, 1);
					}
				}
			}
			if (role === 'fold') {
				m.content = `<context-summary id="${m.group}" topic="${m.topic}">
${m.content}
</context-summary>`;

				seq += m.end - m.start + 1;
			} else {
				seq++;
			}

			if (compressionCalls.length) {
				for (let j = 0; j < compressionCalls.length; j++) {
					const [arg, result] = compressionCalls[j];

					const rangeStr = [];
					for (let k = 0; k < arg.ranges.length; k++) {
						const { startId, endId } = arg.ranges[k];
						rangeStr.push(startId+'-'+endId);
					}

					const pron = result.blockIds > 1;
					output.splice(++i, 0, {
						role: 'user',
						content: `<context-compressed topic="${arg.topic}">
Compression finished. Range${pron ? 's' : ''} [${rangeStr.join(', ')}] ${pron?'are':'is'} replaced by summary block${pron ? 's' : ''} [${result.blockIds.join(', ')}].
</context-compressed>`
					})
				}
			}
		}

		// reminder
		const usage = conv.contextUsage;
		const limit = config.maxContext;

		if (limit && !state.manual && usage > 0) {
			const pct = usage / limit;

			if (pct > 0.8) {
				if (state.nudgeCounter >= 5) {
					output.push({
						role: "user",
						content: `<context-compression-reminder>
CRITICAL: Context usage is high. Use the \`Compress\` tool NOW.
Prioritize one large, closed range from older history.
Do not continue normal exploration until compression is handled.
</context-compression-reminder>`
					})
					state.nudgeCounter = 0
				} else {
					state.nudgeCounter++
				}
			} else if (pct > 0.4) {
				if (state.nudgeCounter >= 5) {
					output.push({
						role: "user",
						content: `<context-compression-reminder>
Context usage is elevated. Look for a closed, self-contained range and compress it.
Prefer older, resolved history. Batch independent ranges if ready.
</context-compression-reminder>`
					})
					state.nudgeCounter = 0
				} else {
					state.nudgeCounter++
				}
			}
		}

		return output;
	}
}

// ── /dcp Commands ──────────────────────────────────────────

const fmt = n => n != null ? n.toLocaleString() : "?"

COMMAND_REGISTRY["dcp"] = [
	async (args) => {
		const sub = args[0] || ""
		const conv = unconscious(selectedConversation);
		if (!conv) {
			showToast("未选中对话", "error");
			return
		}

		const state = getState(conv);

		// TODO 被动压缩
		switch (sub) {
			default: {
				const path = await getMessages(conv);
				const blocks = path.filter(m => m.role === 'fold');
				const lines = [
					"/dcp ui          — 打开上下文管理器",
					"/dcp manual on   — 开启手动模式",
					"/dcp manual off  — 关闭手动模式",
					"",
					`顶层压缩块: ${blocks.filter(b => !b.disabled).length} 活跃 / ${blocks.length} 总计`,
					`Token 节省(估): ${fmt(state.tokensSaved)}`,
					`自动压缩: ${!state.manual ? "开" : "关"}`
				];
				showToast(lines.join("\n"), "info");
				break
			}

			case "ui": {
				import ("./MessageFold.jsx").then(mod => mod.showMessageFolder());
				break
			}

			case "manual": {
				const mode = args[1]
				if (mode === "on") {
					state.manual = true
					showToast("手动模式: 开 — 不再自动提醒压缩，LLM 也不会主动压缩", "info")
				} else if (mode === "off") {
					state.manual = false
					showToast("手动模式: 关 — 恢复自动压缩提醒", "info")
				} else {
					showToast(`手动模式: ${state.manual ? "开" : "关"}`, "info")
				}
				break
			}
		}
	},
	"上下文管理: /dcp [ui|manual [on|off]]"
]
