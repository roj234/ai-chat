import {messages, selectedConversation, VID_FAKE_LAST_USER} from "/src/states.js";
import {updateConversation} from "/src/database.js";
import {enableBranches} from "/src/utils/BranchManager.js";
import {$stampLock, unconscious} from "unconscious";
import {agentLoop} from "/src/api-request.js";
import {COMMAND_REGISTRY} from "/src/commands.js";
import {USER_PROMPT, USER_PROMPT_ROLE} from "../pluginApi.js";

const prompt = `Pause the current task and write a structured Markdown handoff for the assistant that will resume it. Assume the handoff will be its only conversation history.

Summarize the conversation up to the checkpoint marker, including any user text before the marker in the same message. The marker and the text following it are harness instructions for this handoff. Use only the available conversation and tool results. Finish this turn by returning the handoff directly as Markdown.

Write the handoff in {{language}}. Preserve exact paths, identifiers, commands, and diagnostic text when their wording matters.

Start with \`# Task Handoff\`. Use the sections below, omitting optional sections with no relevant content.

## Goal and requirements

State the requested deliverable and what counts as complete. Record the user's conversation language and any language or format required for the deliverable. Incorporate the latest user corrections, including short follow-ups that change an earlier requirement.

## Current state

Give the last confirmed state and the exact point where work stopped. If an operation was still running or its outcome was unknown, include its identifier when available.

## Key facts and decisions

Keep the facts needed to resume. Attribute decisions to the user or assistant when that affects whether they can be revisited. Mark consequential assumptions as unverified.

## Files and completed work

For each relevant artifact, give its path or location, what was inspected, created, or changed, and how far verification got. Include completed deliverables that exist only in the conversation.

## Tools, findings, and pitfalls

Keep tool calls whose results affect the next decision or would be costly to reproduce. Pair each with its outcome. For failed attempts, preserve the symptom, any confirmed cause, and any workaround that succeeded.

## Remaining work

Begin with the first concrete action the next assistant can take. List outstanding tasks in dependency order, including unresolved questions and verification still needed. If progress requires user input, state exactly what is missing. If the task is complete, say so.

When space is limited, prioritize the latest user request, active constraints, verified state, and the next action. Summarize repeated attempts once.`;

COMMAND_REGISTRY['compact'] = [
	async () => {
		const conv = unconscious(selectedConversation);
		const bm = enableBranches(conv);
		const lock = $stampLock(messages, bm);

		const fakeLastUser = {
			id: VID_FAKE_LAST_USER,
			role: USER_PROMPT_ROLE,
			content: "正在总结上下文……",
			[USER_PROMPT]: prompt.replace("{{language}}", navigator.language || "user's established conversation language, inferred from their own messages")
		};
		lock.push(fakeLastUser);

		const [finishReason, assistantMessage] = await agentLoop(conv, lock, null, { noTool: true, usage: 'compact', capture: true });

		const rawMessages = bm.raw;
		const pos = rawMessages.lastIndexOf(fakeLastUser);
		if (pos >= 0) {
			rawMessages.splice(pos, 1);
			bm.setLeaf(rawMessages.at(-1));
		}

		if (finishReason === 'stop' && assistantMessage.content.trim().startsWith("# Task Handoff")) {
			bm.fold(0, bm.length-1, {
				time: Date.now(),
				content: assistantMessage.content,
			});
		} else {
			assistantMessage.error ||= '总结失败: 格式非法';
			bm.push(assistantMessage);
		}

		lock[0] = lock[0];
		bm.setLeaf(rawMessages.at(-1));
		await updateConversation(conv, bm);
	},
	'总结当前对话'
];
