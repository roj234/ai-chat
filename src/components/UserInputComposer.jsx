import {
	abortCompletion,
	config,
	ensureActiveConversation,
	inputText,
	isMobile,
	lastScrollDirectionIsUp,
	messages,
	selectedConversation
} from "../states.js";
import {scrollMessagesToBottom, statusBadge, submitUserChatMessage} from "../api-request.js";
import {blobToContentPart, createAttachmentGallery} from "./InputAttachment.jsx";
import {CUSTOM_CONTROLS} from "../settings.js";
import {createSendButton} from "./SendButton.jsx";
import {bind} from "../utils/utils.js";
import {$computed, $state, $watch, unconscious} from "unconscious";
import {handleCommand} from "../commands.js";
import SimpleModal from "./SimpleModal.jsx";
import {getBlob} from "../database.js";
import {webviewUploadImage} from "/vendor/jsBridge.js";
import {Recorder} from "/plugins/voiceInput/Recorder.jsx";
import {DI} from "../hooks.js";

export const createUserInputComposer = (scroller) => {
	/** @type {import("unconscious").Reactive<OpenAI.ContentPart[]>} */
	const attachments = $state([]);
	const fileInput = <input type="file" multiple onChange={({target}) => {

		const isFileTransferWindow = selectedConversation.id === 0;

		for (const file of target.files) {
			blobToContentPart(file, isFileTransferWindow, attachments, true);
		}

		target.value = '';
	}}/>;

	$watch([selectedConversation, $computed(() => config.modalities)], () => {
		if (selectedConversation.id === 0) {
			fileInput.accept = "*";
			return;
		}

		// 文本文件
		const mime = ["text/plain"/*, "application/json", "text/html", "image/svg"*/];

		if (config.modalities.includes("audio")) {
			mime.push("audio/wav,audio/mp3,audio/flac,audio/ogg");
		}
		if (config.modalities.includes("image")) {
			mime.push("image/png,image/jpeg,image/bmp,image/gif,image/apng,image/webp");
		}
		if (config.modalities.includes("video")) {
			mime.push("video/mp4,video/avi,video/m4v");
		}
		fileInput.accept = mime.join(",");
	})

	/**
	 * @type {HTMLElement}
	 */
	let userInput,
		backToBottomBtn,
		sendButton = DI.sendButton = createSendButton(attachments, onSend);

	const blobCallback = blob => {
		if (blob) blobToContentPart(blob, 0 === selectedConversation.id, attachments);
	};

	const element = (<div className="composer" class:hidden={() => isMobile && unconscious(lastScrollDirectionIsUp)}>
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
						scroller.scrollTop = scroller.scrollHeight;
					}} title={"返回底部"}/>
		</div>
		<div className="query">
			<h1 className={"drag"}>松开上传</h1>
			<textarea placeholder="有事尽管问我" id="userInput" ref={userInput}
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
				<div className="dropdown">
					<button className="ri-attachment-2 btn ghost" title="添加附件" onClick={isMobile ? undefined : () => fileInput.click()}></button>
					<div className="list mid up">
						{IS_ANDROID_BUILD && <label className="ri-camera-4-fill" onClick={() => {
							webviewUploadImage().then(blobCallback)
						}}>
							拍照
						</label>}
						<label className="ri-mic-fill" onClick={() => {
							const modal = <div className={'modal-overlay'}>
								<div className={'modal'} onClick={(e) => e.stopPropagation()}>
									<div className={"header"}>
										<b>录音机</b>
										<div className={"spacer"} />
										<button className="ri-close-line btn ghost" onClick={() => modal.remove()} title={"关闭"} />
									</div>
									<Recorder onSubmit={(blob) => {
										blobCallback(blob);
										modal.remove();
									}}/>
								</div>
							</div>;
							document.body.append(modal);
						}}>录制语音</label>
						<label className="ri-attachment-2" onClick={() => fileInput.click()}>选择文件</label>
					</div>
				</div>

				{sendButton}
			</div>
		</div>
	</div>);

	const dropZone = element.lastElementChild;
	dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
	dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
	dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
	dropZone.addEventListener('drop', (e) => {
		e.preventDefault();
		dropZone.classList.remove('drag-over');
		const dt = e.dataTransfer;
		if (dt?.files.length) {
			const isFileTransferWindow = selectedConversation.id === 0;
			for (const file of dt.files) {
				blobToContentPart(file, isFileTransferWindow, attachments, true);
			}
		}
	});

	// 这可以用框架语法，但IDE很生气
	bind(userInput, inputText);

	userInput.addEventListener("paste", (event) => {
		const clipboardItems = event.clipboardData?.items;
		if (!clipboardItems) return;

		const files = [];

		for (const item of clipboardItems) {
			if (item.kind === 'file') {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}

		if (files.length) {
			event.preventDefault();

			const isFileTransferWindow = selectedConversation.id === 0;
			for (const file of files) {
				blobToContentPart(file, isFileTransferWindow, attachments, true);
			}
		}
	});

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
						title: `文本较长（${text.length} 字符）`,
						message: "是否转为附件？",
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
		const imageRegex = /^!\[image(\d+)]|!\[blob]\(([\da-zA-Z_-]{43})\)$/gm;
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
				const [str, imageIdxStr, hash] = match;

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

		const noAI = selectedConversation.noAI;
		if (input) {
			if (!input.length) return;
			const userMessage = {role: 'user', content: input, time: Date.now()};

			const nickname = config.nickname;
			if (noAI && nickname) userMessage.name = nickname;

			messages.push(userMessage);
		} else {
			if (sendButton.disabled) return;
		}

		if (noAI) return;

		scrollMessagesToBottom();

		await ensureActiveConversation();

		if (config.reviewMessage && input) return;
		submitUserChatMessage(true);
	}

	const backToBottomBtnShowHide = () => {
		const top = scroller.scrollTop;
		const b = scroller.scrollHeight - scroller.offsetHeight - top > 250;
		backToBottomBtn.style.display = b && messages.length ? "" : "none";
	};

	scroller.addEventListener("scroll", backToBottomBtnShowHide);

	return [element, backToBottomBtnShowHide];
}