import {getToolParameters, registerToolset} from "/src/toolset.js"
import {config, MessageRoles, messages, onConversationLoaded, selectedConversation} from "/src/states.js"
import {SETTINGS} from "/src/settings.js"
import {COMMAND_REGISTRY} from "/src/commands.js"
import {showToast} from "/src/components/Toast.js"
import {unconscious} from "unconscious"

SETTINGS.push({
	id: "maxContext",
	type: "number",
	_tab: "tools",
	_group: "model",
	name: "上下文窗口大小",
	title: "用于 GUI 渲染和自动压缩提醒 (0 关闭)\n需要 API 返回 token 明细",
	min: 0,
	max: 1048576,
	step: 1024
});

const ID = "__dcp"

/**
 * @param {AiChat.Conversation} conv
 */
const getState = conv => conv[ID] || (conv[ID] = {
	blocks: [],        // {id, topic, summary, startId, endId, active}
	nextBlockId: 1,
	tokensSaved: 0,
	manual: false,
	nudgeCounter: 0,
});

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

	script(params, response, conv) {
		const state = getState(conv)
		const newIds = [];

		for (const range of params.ranges) {
			const { startId, endId } = range

			// Resolve block ID references: bN → stored block
			let resolvedStart = startId
			let resolvedEnd = endId

			const blockMatchStart = startId.match(/^b(\d+)$/i)
			const blockMatchEnd = endId.match(/^b(\d+)$/i)

			if (blockMatchStart) {
				const b = state.blocks.find(x => x.id === parseInt(blockMatchStart[1]) && x.active)
				if (!b) throw `Unknown block ID: ${startId}`
				resolvedStart = b.startId
			}
			if (blockMatchEnd) {
				const b = state.blocks.find(x => x.id === parseInt(blockMatchEnd[1]) && x.active)
				if (!b) throw `Unknown block ID: ${endId}`
				resolvedEnd = b.endId
			}

			// Validate mNNN format
			if (!/^m\d{3}$/.test(resolvedStart)) throw `Invalid start ID: ${startId} (expected mNNN or bN)`
			if (!/^m\d{3}$/.test(resolvedEnd)) throw `Invalid end ID: ${endId} (expected mNNN or bN)`

			// Expand (bN) placeholders in summary
			let summary = range.summary.replace(/\(b(\d+)\)/g, (match, idStr) => {
				const block = state.blocks.find(b => b.id === parseInt(idStr) && b.active)
				return block
					? `[Previously compressed: ${block.topic}]\n${block.summary}`
					: match
			})

			// Overlap check
			for (const existing of state.blocks) {
				if (!existing.active) continue
				const aBefore = resolvedStart <= existing.endId
				const bAfter = existing.startId <= resolvedEnd
				// Simple overlap: IDs are sequential, so string comparison works for mNNN
				if (aBefore && bAfter) {
					throw `Overlap with existing block b${existing.id} "${existing.topic}"`
				}
			}

			const block = {
				id: state.nextBlockId++,
				topic: params.topic,
				summary,
				startId: resolvedStart,
				endId: resolvedEnd,
				active: true,
			}
			state.blocks.push(block)
			newIds.push(block.id)
		}

		response.blockIds = newIds
		return `Compressed ${newIds.length} range(s): ${params.topic}`
	},
	undo(resp, conv) {
		const blockIds = resp.blockIds;
		if (!blockIds) return;

		const state = getState(conv);
		const toDelete = new Set(blockIds);
		state.blocks = state.blocks.filter(x => !toDelete.has(x.id));

		while (toDelete.has(state.nextBlockId - 1)) state.nextBlockId--;
	},

	title(req, resp) {
		const args = getToolParameters(resp, req);
		return `压缩: ${args.topic} `+resp.blockIds;
	}
};

// 这只是个占位符，别想着模型会主动调用它
const Marker = {
	name: "Marker",
	description: `Place a named bookmark in the conversation. Use this at meaningful boundaries so you can later reference exact positions when compressing with the compress tool.`,

	parameters: {
		type: "object",
		properties: {
			label: {
				type: "string",
				description: "A short, unique identifier for this bookmark.",
			}
		},
		required: ["label"]
	},

	script({label}) {
		return `Marker set: ${label}`
	},

	title(req, resp) {
		const note = getToolParameters(resp, req);
		return `📌 ${note.label}`
	}
}

registerToolset("ContextCompression", "上下文压缩", [Compress, Marker], {
	hidden: 'manual',
	systemPrompt: `<context-management>
You have a \`Compress\` tool for managing context. It replaces stale conversation ranges with dense technical summaries.

## Philosophy
Compression crystallizes raw exploration into refined understanding. Your summary becomes the authoritative record.

## When to Compress
- Research concluded and findings are clear
- Implementation finished and verified
- Exploration exhausted and patterns understood
- Dead-end noise can be discarded

## When NOT to Compress
- Raw context still needed for edits or precise references
- Content still actively in progress
- You may need exact code, error messages, or file contents next

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

It is your responsibility to keep a sharp, high-quality context window.
</context-management>`,
	onActivated() {
		const msgs = unconscious(messages)
		if (!msgs.some(m => m.role === ID)) {
			msgs.unshift({
				role: ID,
				id: -1,
				hidden: true,
			});
		}
		return [Compress, Marker]
	},
	onDeactivated() {
		const msgs = unconscious(messages)
		for (let i = 0; i <= msgs.length; i++) {
			if (msgs[i].role === ID) {
				msgs.splice(i, 1);
				break
			}
		}
	}
})
onConversationLoaded((conv, messages, loadFromCache) => {
	if (!loadFromCache && conv.activatedModules?.has("ContextCompression")) {
		messages.unshift({
			role: ID,
			id: -1,
			hidden: true,
		});
	}
});

MessageRoles[ID] = {
	/**
	 * Virtual message that injects IDs and applies compression via callback.
	 * Does NOT add anything to output (LLM never sees this message).
	 */
	compose(self, output, callbacks, index, length, conv) {
		callbacks.push((messages_, json_messages, body, isPrefill) => {
			const state = getState(conv)
			if (!state) return

			// ── ① Inject message IDs ──────────────────────────
			/** @type {Map<string, number>} */
			const idToIndex = new Map()

			for (let i = 0; i < json_messages.length; i++) {
				const m = json_messages[i]
				const role = m.role;

				const messageId = "m"+String(i).padStart(3, '0');
				idToIndex.set(messageId, i);

				if (role === 'user') {
					if (typeof m.content === "string") {
						m.content += `\n<marker>${messageId}</marker>`
					} else if (Array.isArray(m.content)) {
						m.content = [...m.content, { type: "text", text: `\n<marker>${messageId}</marker>` }]
					}
				} else if (role === 'assistant') {
					let tools = m.tool_calls;
					found:
					if (tools) {
						for (let j = 0; j < tools.length; j++){
							let tc = tools[j];
							const name = tc.function.name;
							if (name === 'Marker' || name === 'Compress') {
								m.tool_calls = tools = [...tools];
								tools.splice(j, 1);
								if (!m.tool_calls.length) {
									if (!m.content) m.content = "[Context compressed]";
									delete m.tool_calls;
								}
								json_messages.splice(i + j + 1, 1);
								break found;
							}
						}
						m.tool_calls = [...tools, {
							id: "tc_"+messageId,
							type: 'function',
							function: {
								name: "Marker",
								arguments: JSON.stringify({label: messageId})
							}
						}];
						json_messages.splice(i += tools.length + 1, 0, {
							role: "tool",
							tool_call_id: "tc_"+messageId,
							content: `Marker set: ${messageId}`
						});
					}
				}
			}

			// compression block
			const activeBlocks = state.blocks
				.filter(b => b.active)
				.map(b => ({
					...b,
					startIdx: idToIndex.get(b.startId),
					endIdx: idToIndex.get(b.endId),
				}))
				.filter(b => b.startIdx != null && b.endIdx != null && b.startIdx <= b.endIdx)
				.sort((a, b) => b.startIdx - a.startIdx)

			for (const block of activeBlocks) {
				// Estimate tokens saved (rough: chars/4)
				let removed = 0
				for (let i = block.startIdx; i <= block.endIdx; i++) {
					removed += JSON.stringify(json_messages[i]).length
				}
				const added = block.summary.length
				state.tokensSaved += Math.max(0, Math.round((removed - added) / 4))

				json_messages.splice(block.startIdx, block.endIdx - block.startIdx + 1)
				json_messages.splice(block.startIdx, 0, {
					role: "user",
					content: `[Compressed section: ${block.topic}]\n\n${block.summary}\n\n<marker>b${block.id}</marker>`
				})
			}

			// reminder
			if (!config.maxContext || state.manual) return;

			const usage = conv.contextUsage;
			if (usage == null || usage <= 0) return;

			const pct = usage / config.maxContext;

			if (pct > 0.8) {
				if (state.nudgeCounter >= 5) {
					json_messages.push({
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
					json_messages.push({
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
		})
	}
}

// ── /dcp Commands ──────────────────────────────────────────

const fmt = n => n != null ? n.toLocaleString() : "?"

COMMAND_REGISTRY["dcp"] = [
	async (args) => {
		const sub = args[0] || ""
		const conv = unconscious(selectedConversation)
		if (!conv) {
			showToast("没有选中的对话", "error")
			return
		}

		const state = getState(conv)

		switch (sub) {
			default: {
				const help = [
					"/dcp context     — 查看上下文使用情况",
					"/dcp decompress N — 恢复压缩块 bN",
					"/dcp manual on   — 开启手动模式",
					"/dcp manual off  — 关闭手动模式",
				].join("\n")
				showToast(help, "info")
				break
			}

			case "context": {
				const usage = conv.contextUsage
				const max = config.maxContext
				const lines = []
				if (usage != null) {
					if (max) {
						const pct = (usage / max * 100).toFixed(1)
						lines.push(`上下文: ${pct}% (${fmt(usage)} / ${fmt(max)} tokens)`)
					} else {
						lines.push(`上下文: ${fmt(usage)} tokens`)
					}
				}
				lines.push(`压缩块: ${state.blocks.filter(b => b.active).length} 活跃 / ${state.blocks.length} 总计`)
				lines.push(`Token 节省(估): ${fmt(state.tokensSaved)}`)
				lines.push(`自动压缩: ${!state.manual ? "开" : "关"}`)
				showToast(lines.join("\n"), "info")
				break
			}

			case "decompress": {
				const nArg = args[1]
				if (nArg == null) {
					const active = state.blocks.filter(b => b.active)
					if (!active.length) {
						showToast("没有活跃的压缩块", "info")
						return
					}
					const lines = ["活跃压缩块:"]
					for (const b of active) {
						lines.push(`  b${b.id} — "${b.topic}" (${b.startId}..${b.endId})`)
					}
					lines.push("", "/dcp decompress N 恢复指定块")
					showToast(lines.join("\n"), "info")
				} else {
					const id = parseInt(nArg, 10)
					if (isNaN(id)) {
						showToast(`无效 ID: ${nArg}`, "error")
						return
					}
					const block = state.blocks.find(b => b.id === id)
					if (!block) {
						showToast(`未找到压缩块 b${id}`, "error")
						return
					}
					if (!block.active) {
						showToast(`b${id} 已经恢复`, "info")
						return
					}
					block.active = false
					showToast(`已恢复 b${id}: "${block.topic}"`, "info")
				}
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
	"上下文压缩管理: /dcp [context|decompress [N]|manual [on|off]]"
]
