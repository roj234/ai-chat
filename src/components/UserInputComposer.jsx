import {
	abortCompletion,
	auxMainlyTouch,
	auxSmallScreen,
	config,
	ensureConversation,
	inputText,
	lastScrollDirectionIsUp,
	messages,
	selectedConversation
} from "../states.js";
import {scrollMessagesToBottom, submitUserChatMessage} from "../api-request.js";
import {AttachmentGallery, blobToContentPart} from "./AttachmentGallery.jsx";
import {CUSTOM_CONTROLS} from "../settings.js";
import {createSendButton} from "./SendButton.jsx";
import {bind} from "../utils/utils.js";
import {$computed, $state, $update, $watch, unconscious} from "unconscious";
import {handleCommand} from "../commands.js";
import SimpleModal from "./SimpleModal.jsx";
import {getBlob} from "../database.js";
import {webviewUploadImage} from "/vendor/jsBridge.js";
import {Recorder} from "/plugins/voiceInput/Recorder.jsx";
import {getCombinedPreset} from "../presets.js";

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
		sendButton = createSendButton(attachments, onSend);

	const blobCallback = blob => {
		if (blob) blobToContentPart(blob, 0 === selectedConversation.id, attachments);
	};

	const debon = $computed(() => config.temporaryChat);
	const element = (<div className="composer" class:hidden={() => auxSmallScreen && unconscious(lastScrollDirectionIsUp)}>
		<div className="logo col hide-human">
			{() => unconscious(debon) ? <div className="row"><i className="ri-eye-off-line" />临时<span className="tooltip">新对话的数据不会保存，并将在刷新后丢失</span></div> : null}
			<span style={{
				display: "flex",
				alignItems: "flex-end",
			}}>
				{() => (config._dirty||'') + (config.name || config.model || "你好")}
				<div className={"tooltip"}>{() => config.model}</div>
			</span>
		</div>
		<button className={"ri-arrow-down-line chip back"} style={"display:none"} ref={backToBottomBtn}
				onClick={() => {
					scroller.scrollTop = scroller.scrollHeight;
				}} title={"返回底部"}/>
		<div className="query">
			<h1 className={"drag"}>松开上传</h1>
			<textarea placeholder="有事尽管问我" id="userInput" enterkeyhint="send" ref={userInput}
					  onInput={() => {
						  // Auto resize when typing
						  userInput.style.height = '';
						  userInput.style.height = (userInput.scrollHeight) + 'px';
					  }}
					  onKeyDown={(e) => {
						  if (auxMainlyTouch) return;
						  if (!e.isComposing && e.key === 'Enter' && !e.shiftKey) {
							  e.preventDefault();
							  if (!unconscious(abortCompletion)) onSend();
						  }
					  }}
			></textarea>
			{AttachmentGallery(attachments)}
			<div className="controls">
				<div className="row hide-human">{CUSTOM_CONTROLS}</div>
				<div className="spacer"></div>
				<div className="dropdown">
					<button className="ri-attachment-2 btn ghost" title="添加附件" onClick={() => {
						if (auxMainlyTouch) return;
						fileInput.click()
					}}></button>
					<div className="list mid up">
						{IS_ANDROID_BUILD && <label className="ri-camera-4-fill" onClick={() => {
							webviewUploadImage().then(blobCallback)
						}}>
							拍摄照片
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
			$update(abortCompletion);
			return;
		}

		const conv = unconscious(selectedConversation);
		if (conv && !conv.ready) return;

		const text = inputText.trim();

		if (text) {
			const prevprev = messages.at(-1);
			if (prevprev?.role === 'assistant' && (prevprev.error || prevprev.finish_reason === 'interrupt' || prevprev.finish_reason === 'length')) {
				const options = [];

				if (!prevprev.error && await getCombinedPreset(conv).canPrefill)
					options.push("清空输入框并点击右下角【继续】");
				options.push("点击上条消息的【重新生成】按钮");
				options.push("在上上条消息处【分支】");

				SimpleModal({
					title: "无法在异常响应后追加数据",
					message: "以下是可用的解决方案：\n"+options.join('\n')
				});
				return;
			}
		}

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
			if (sendButton.firstElementChild.disabled) return;
		}

		scrollMessagesToBottom();

		if (noAI) return;

		await ensureConversation();

		if (config.reviewMessage && input) return;
		submitUserChatMessage(true);
	}

	const io = new IntersectionObserver(([entry]) => {
		backToBottomBtn.style.display = !entry.isIntersecting ? "" : "none";
	});

	return [element, io];
}