import {getToolParameters, registerToolset} from "/src/toolset.js"
import {MessageRoles, messages, onConversationLoaded, updateMessageUI} from "/src/states.js"
import {$update, unconscious} from "unconscious"
import {enableBranches, expandFolds} from "/src/utils/BranchManager.js";
import {getImmediateMessages, getMessages, markMessageDirty,} from "/src/database.js";
import {createFileSystemAsync, VHandle} from "../agent/index.js";
import {FSE_NotFound, throwDOMException} from "/common/pure-utils.js";
import {NestedMap} from "unconscious/common/NestedMap.js";
import {resolvePreset} from "/src/presets.js";

import {customRoleRegHelper} from "../pluginApi.js";
import {JsonFile} from "../agent/VirtualFileSystem.js";
import {createWebFileSystem} from "../agent/WebFSDriver.js";
import {escapeHtmlAttr} from "@roj234/shared/strings";

export const DCP_ID = "ContextCompression";

/**
 * @param {AiChat.Conversation} conv
 */
const getState = conv => (conv[DCP_ID] ??= {
	estSaved: 0,
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
			const count = m.end - m.start + 1;
			if (m.disabled) {
				for (let j = 0; j < count; j++) {
					idMap.set("m"+pad3(seq + j), -m.group);
				}
			}
			idMap.set(m.group, i);
			seq += count;

			const n = parseInt(m.group.slice(1), 10);
			if (n >= nextGroup) nextGroup = n + 1;
		} else {
			idMap.set("m"+pad3(seq), i);
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
		const path = await getMessages(conv);
		let {idMap, nextGroup} = computeIds(path);

		const topic = params.topic;
		const resolved = [];

		for (const range of params.ranges) {
			const { startId, endId } = range;

			let startIdx = idMap.get(startId);
			if (startIdx == null) throw `Invalid or unknown message/block for startId: ${startId}`;
			let endIdx = idMap.get(endId);
			if (endIdx == null) throw `Invalid or unknown message/block for endId: ${endId}`;

			if (startIdx < 0) throw `Message ${startId} is inside a DISABLED block b${-startIdx} and cannot be operate individually. Ask user for details.`;
			if (endIdx < 0) throw `Message ${endId} is inside a DISABLED block b${-endIdx} and cannot be operate individually. Ask user for details.`;

			if (startIdx === endIdx) throw "Range must contain more than 1 message";
			if (startIdx > endIdx) throw `startId (${startId}) must appear before endId (${endId})`;

			if (path[startIdx].role === 'user' && path[startIdx + 1].role !== 'user') startIdx++;

			let removed = 0;
			for (let i = startIdx; i <= endIdx; i++) removed += JSON.stringify(path[i]).length;

			resolved.push({
				startIdx,
				endIdx,
				estSaved: removed,
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

		let saved = 0;
		for (const r of ordered) {
			saved += r.estSaved;
		}

		ordered.reverse();

		nextGroup += ordered.length;

		const bm = enableBranches(conv);
		const newIds = [];
		for (const { startIdx, endIdx, summary } of ordered) {
			const groupId = "b" + --nextGroup;

			bm.fold(startIdx, endIdx, {
				//foldRole: "user",
				topic,
				time: Date.now(),
				content: summary,
			}, groupId, true);

			newIds.push(groupId);
		}

		bm.update();
		if (unconscious(messages) === bm) $update(updateMessageUI);
		response.blockIds = newIds;
		response.usage = conv.contextUsage;
		response.estSaved = saved;

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
/** @type {AiChat.FunctionTool} */
const Marker = {
	name: "Marker",
	description: `Place a bookmark in the conversation. Use this at meaningful boundaries so you can later reference exact positions when compressing with the compress tool.`,
	script() {return '\0'},
	title() {return `📌`}
}

/**
 * @type {AiChat.VirtualFileHandleHandler}
 */
const messageItemHandler = JsonFile({
	meta(path) {
		const data = path.at(-1);
		return [data.time, data];
	}
})

/**
 * @type {AiChat.VirtualDirectoryHandleHandler}
 */
const messageListHandler = {
	async child(childPath, dir) {
		if (dir) return;

		const name = childPath.at(-1);
		const conv = childPath[0];
		const path = expandFolds(await getMessages(conv), true);
		let {idMap} = computeIds(path);

		const i = idMap.get(name.slice(0, -5));
		if (i == null) throwDOMException(name, FSE_NotFound);

		childPath[childPath.length - 1] = path[i];
		return messageItemHandler;
	},
	async *entries(arr) {
		const conv = arr[0];
		const path = expandFolds(await getMessages(conv), true);
		let {idMap} = computeIds(path);

		for (const [k, v] of idMap.entries()) {
			yield [k+".json", {
				read() {
					return {
						size: path[v].content.length || -1,
						lastModified: path[v].time || Date.now()
					}
				}
			}];
		}
	},
}
const VFSRoot = new NestedMap();

registerToolset(DCP_ID, "允许模型主动管理上下文\n" +
	"[/ctx](cmd://ctx) 打开编辑器，你可以编辑或压缩上下文。\n" +
	"`/compact` 让模型压缩当前上下文。\n" +
	"关闭后，仍可点击或输入上述命令。", [Compress, Marker], {
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
- All context stays inside \`~/history/\` (\`mNNN.json\` per message), nothing is physically deleted.

It is our responsibility to keep a sharp, high-quality context window.
</context-management>`,
	onActivated(conv) {
		registerRole(conv);
		return [Compress, Marker];
	},
	onDeactivated(conv) {
		unregisterRole(conv);
		delete conv.mnt?.['history'];
	}
})

const [registerRole_, unregisterRole] = customRoleRegHelper(DCP_ID);

function registerRole(conv) {
	if (!registerRole_(conv)) return;

	const instance = {};
	createFileSystemAsync(instance, createWebFileSystem(new VHandle(VFSRoot, [conv], messageListHandler)));
	(conv.mnt ??= {})['history'] = instance;
}

onConversationLoaded((conv, path, messages) => {
	if (conv.activatedModules?.has(DCP_ID)) registerRole(conv, messages);
});

MessageRoles[DCP_ID] = {
	async preprocess(self, messages, conv) {
		const state = getState(conv);
		if (!state) return;

		const output = messages.map(m => ({...m}));
		const limit = (await resolvePreset(conv)).maxContext;
		let saved = 0;

		let seq = 1;

		let k = 0;
		for (let i = 0; i < output.length; i++, k++) {
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
					const realTC = tools;
					const realTR = m.tool_responses || [];

					tools = [...realTC];
					const tr = [...realTR];

					m.tool_calls = tools;
					m.tool_responses = tr;

					for (let j = tools.length - 1; j >= 0; j--) {
						const tc = tools[j];
						const name = tc.function.name;
						if (name === 'Compress' || name === 'Marker') {
							if (name === 'Compress') {
								const result = tr[j];
								if (result?.success !== true) continue;
								compressionCalls.push([getToolParameters(result, tc), result]);
							} else {
								realTC.splice(j, 1);
								realTR.splice(j, 1);
								markMessageDirty(messages[k]);
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
				m.content = `<context-summary ${m.topic != null ? `id="${m.group}" topic="${m.topic}"` : 'manual'}>
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

					const pron = result.blockIds.length > 1;
					output.splice(++i, 0, {
						role: 'user',
						content: `<context-compression-event topic="${escapeHtmlAttr(arg.topic)}">
Compression finished. Range${pron ? 's' : ''} [${rangeStr.join(', ')}] ${pron?'are':'is'} replaced by summary block${pron ? 's' : ''} [${result.blockIds.join(', ')}].
${result.usage != null ? `Context usage before compression: ${result.usage} / ${limit}. Token saved (approx): ${result.estSaved / 4}\n`: ''}</context-compression-event>`
					});
					saved += result.estSaved;
				}
			}
		}

		// reminder
		const usage = conv.contextUsage;

		state.estSaved += saved;

		if (limit && state.nudgeCounter >= 0 && usage > 0) {
			const pct = usage / limit;
			if (pct > 0.8 || limit - usage < 32768) {
				if (state.nudgeCounter >= 5) {
					output.push({
						role: "user",
						content: `<context-compression-reminder>
Context: ${usage} / ${limit} (${(pct * 100).toFixed(0)}%). Look for a closed, self-contained range and compress it.
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
