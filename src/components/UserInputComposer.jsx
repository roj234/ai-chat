import {
	abortCompletion,
	config,
	conversations,
	inputText,
	isMobile,
	lastScrollDirection,
	messages,
	selectedConversation
} from "../states.js";
import {statusBadge, submitUserChatMessage} from "../api-request.js";
import {blobToContentPart, createAttachmentGallery, createFileUploader} from "./InputAttachment.jsx";
import {CUSTOM_CONTROLS} from "../settings.js";
import {createSendButton} from "./SendButton.jsx";
import {bind} from "../utils/utils.js";
import {$state, unconscious} from "unconscious";
import {handleCommand} from "../commands.js";
import SimpleModal from "./SimpleModal.jsx";
import {getBlob, updateConversation} from "../database.js";
import {webviewUploadImage} from "/vendor/jsBridge.js";


export const createUserInputComposer = (scroller) => {
	/** @type {import("unconscious").Reactive<OpenAI.ContentPart[]>} */
	const attachments = $state([]);
	const fileInput = createFileUploader(attachments);

	/**
	 * @type {HTMLElement}
	 */
	let userInput,
		backToBottomBtn,
		sendButton = createSendButton(attachments, onSend);

	const element = (<div className="composer" class:hidden={() => config.uiAutoHideInput && lastScrollDirection.value}>
		<div className="logo hide-human">
					<span style={{
						display: "flex",
						alignItems: "flex-end",
					}}
						  dangerouslySetInnerHTML={() => config.name || "<span class='ri-ai' style='font-size:40px'></span>Chat"}></span>

			<span style={{
				height: "80px",
				color: "var(--accent)"
			}} className="ri-chat-smile-ai-fill"></span>
		</div>
		<div className={"f-controls"}>
			{statusBadge}
			<button className={"ri-arrow-down-s-line chip"} style={"display:none"} ref={backToBottomBtn}
					onClick={() => {
						scroller.scrollTo({
							top: scroller.scrollHeight,
							behavior: "smooth",
						})
					}} title={"返回底部"}/>
		</div>
		<div className="query">
						<textarea placeholder="今天有什么能帮到你？" id="userInput" ref={userInput}
								  onInput={() => {
									  // Auto resize when typing
									  userInput.style.height = '';
									  userInput.style.height = (userInput.scrollHeight) + 'px';
								  }}
								  onKeyDown={(e) => {
									  if (isMobile) return;
									  if (e.key === 'Enter' && !e.shiftKey) {
										  e.preventDefault();
										  if (!unconscious(abortCompletion)) onSend();
									  }
								  }}
						></textarea>
			{createAttachmentGallery(attachments)}
			<div className="controls">
				<div className="controls hide-human">{CUSTOM_CONTROLS}</div>
				<div className="spacer"></div>
				{IS_ANDROID_BUILD && <button className="ri-camera-4-fill btn ghost" title="拍照上传"
						 onClick={() => {
							 webviewUploadImage().then(blob => {
								 if (blob) blobToContentPart(blob, 0 === selectedConversation.id, attachments);
							 })
						 }}></button>}
				<button className="ri-attachment-2 btn ghost" title="上传附件"
						onClick={() => fileInput.click()}></button>
				{sendButton}
			</div>
		</div>
	</div>);

	// 这可以用框架语法，但IDE很生气
	bind(userInput, inputText);

	async function onSend() {
		if (await handleCommand(inputText, userInput)) return;

		// Abort previous if any
		const aborter = unconscious(abortCompletion);
		if (aborter) {
			aborter.abort();
			return;
		}

		if (!selectedConversation.ready) {
			if (unconscious(selectedConversation)) return;
		}

		const text = inputText.trim();
		inputText.value = '';
		userInput.style.height = '';

		let choice;
		const convertToBlob = async (text, capsule) => {
			if (text.length >= 50000) {
				const huge = text.length > 200000;
				if (!huge && null == choice) choice = await new Promise((resolve) => {
					SimpleModal({
						title: "文本很长 ("+text.length+"字符)",
						message: "是否转换为附件？",
						onConfirm(){resolve(true)},
						onCancel() {resolve(false)}
					})
				});
				if (choice || huge) {
					return new Blob([text], {type: "text/plain"});
				}
			}
			return text;
		}

		let input;
		// in order to generate image:
		// modalities: ['image', 'text'],

		// Syntax: 单行 ![image](1)
		const imageRegex = /^!\[image(\d+)]|!\[blob]\(([\da-zA-Z_-]{43})\)|!\[file]\((.+?)\)$/gm;
		{
			const parts = [];
			let lastIndex = 0;
			let match;
			const usedIndices = new Set();

			const flushText = () => {
				const before = text.slice(lastIndex, match.index).trim();
				if (before) parts.push({ type: "text", text: before });
				lastIndex = imageRegex.lastIndex;
			};

			// 寻找匹配的标签并插入图片
			while ((match = imageRegex.exec(text)) !== null) {
				const [str, imageIdxStr, hash, fileName] = match;
				console.log(match);

				if (imageIdxStr) {
					const imageIdx = parseInt(imageIdxStr, 10) - 1;

					if (attachments[imageIdx]) {
						flushText();
						parts.push(attachments[imageIdx]);
						usedIndices.add(imageIdx);
						continue;
					}
				} else if (hash) {
					try {
						const blob = await getBlob({hash});
						flushText();
						blobToContentPart(blob, 0 === selectedConversation.id, parts);
						continue;
					} catch {}
				} else if (fileName) {
					// TODO
				}

				parts.push({ type: "text", text: await convertToBlob(str) });
			}

			if (lastIndex === 0 && !attachments.length) {
				const blob = await convertToBlob(text, true);
				input = blob || null;
			} else {
				const after = text.slice(lastIndex).trim();
				if (after) parts.push({ type: "text", text: await convertToBlob(after) });

				attachments.forEach((attachment, index) => {
					if (!usedIndices.has(index)) parts.push(attachment);
				});
				attachments.length = 0; // 清空附件

				input = parts;
			}
		}

		if (input) {
			const userMessage = {role: 'user', content: input, time: Date.now()};

			const nickname = config.nickname;
			if (selectedConversation.noAI && nickname) userMessage.name = nickname;

			messages.push(userMessage);
			if (config.reviewMessage) return;
		} else {
			if (sendButton.disabled) return;
		}

		if (selectedConversation.noAI) return;

		if (null == selectedConversation.id) {
			// 创建新对话
			const conv = {
				title: "",
				time: Date.now(),
				ready: true
			};
			if (config.branchModeDefault) conv.bm_leaf = 1;
			if (config.incognito) conv.id = -1;

			await updateConversation(conv, unconscious(messages), true);

			conversations.unshift(conv);
			selectedConversation.value = conv;
		}

		for (;;) {
			const result = await submitUserChatMessage();
			if (result !== 'tool_calls') break;
			input = null;
		}
	}

	const backToBottomBtnShowHide = () => {
		const top = scroller.scrollTop;
		const b = scroller.scrollHeight - scroller.offsetHeight - top > 250;
		backToBottomBtn.style.display = b ? "" : "none";
	};

	scroller.addEventListener("scroll", backToBottomBtnShowHide);

	return [element, backToBottomBtnShowHide];
}