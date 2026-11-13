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
import {submitUserChatMessage} from "../api-request.js";
import {AttachmentGallery, blobToAttachment} from "./AttachmentGallery.jsx";
import {createSendButton} from "./SendButton.jsx";
import {bind, scrollMessagesToBottom} from "../utils/utils.js";
import {$derived, $state, $update, $watch, unconscious} from "unconscious";
import {handleCommand} from "../commands.js";
import SimpleModal from "./SimpleModal.jsx";
import {getBlob} from "../database.js";
import {webviewUploadImage} from "/vendor/jsBridge.js";
import {openRecorder} from "/plugins/voiceInput/Recorder.jsx";
import {resolvePreset} from "../presets.js";
import {cannotInsertAfter, injectMessages} from "../inject-message.js";
import {PendingMessageList} from "./PendingMessageList.jsx";
import {DI, DID_INPUT_BOX_POSITION} from "../hooks.js";
import {CUSTOM_CONTROLS} from "../customControls.js";

export const TEXT_MIMES = "text/plain";
export const AUDIO_MIMES = "audio/wav,audio/mp3,audio/flac,audio/ogg";
export const IMAGE_MIMES = "image/png,image/jpeg,image/bmp,image/gif,image/apng,image/webp";
export const VIDEO_MIMES = "video/mp4,video/avi,video/m4v";

/**
 *
 * @param {string} text
 * @param {OpenAI.ContentPart[]} attachments
 * @return {Promise<File|string|OpenAI.ContentPart[]>}
 */
async function parseUserInput(text, attachments) {
	let choice;
	const longTextToAttachment = async (text) => {
		if (text.length >= 50000) {
			const huge = text.length > 200000;
			if (!huge && null == choice) choice = await new Promise((resolve) => {
				SimpleModal({
					title: `文本较长（${text.length} 字符）`,
					message: "是否转为附件？",
					onConfirm() {
						resolve(true)
					},
					onCancel() {
						resolve(false)
					}
				})
			});
			if (choice || huge) {
				return new File([text], text.slice(0, 32), {type: "text/plain"});
			}
		}
		return text;
	}

	// Syntax: 单行 ![image](1)
	const imageRegex = /^!\[image(\d+)]|!\[blob]\(([\da-zA-Z_-]{43})\)$/gm;
	{
		const parts = [];
		let lastIndex = 0;
		let match;
		const usedIndices = new Set();

		const flushText = () => {
			const before = text.slice(lastIndex, match.index).trim();
			if (before) parts.push({type: "text", text: before});
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
					blobToAttachment(blob, 0 === selectedConversation.id, parts);
					continue;
				} catch {
				}
			}

			parts.push({type: "text", text: await longTextToAttachment(str)});
		}

		if (lastIndex === 0 && !attachments.length) {
			return await longTextToAttachment(text, true);
		} else {
			const after = text.slice(lastIndex).trim();
			if (after) parts.push({type: "text", text: await longTextToAttachment(after)});

			for (let index = 0; index < attachments.length; index++){
				const attachment = attachments[index];
				await attachment.loading;

				if (!usedIndices.has(index)) parts.push(attachment);
			}
			return parts;
		}
	}
}

export const createUserInputComposer = (scroller) => {
	/** @type {import("unconscious").Reactive<OpenAI.ContentPart[]>} */
	const attachments = $state([]);
	const fileInput = <input type="file" multiple onChange={({target}) => {
		for (const file of target.files) blobToAttachment(file, attachments);
		target.value = '';
	}}/>;

	$watch([selectedConversation, $derived(config.modalities)], async () => {
		const conv = unconscious(selectedConversation);
		if (conv?.id === 0) {
			fileInput.accept = "*";
			return;
		}

		const opt = !conv ? config : await resolvePreset(conv);

		// 文本文件
		const mime = [TEXT_MIMES];
		if (opt.modalities.includes("audio")) mime.push(AUDIO_MIMES);
		if (opt.modalities.includes("image")) mime.push(IMAGE_MIMES);
		fileInput.accept = mime.join(",");
	});

	const pendingMessages = $derived(selectedConversation.pendingMessages);

	/**
	 * @type {HTMLElement}
	 */
	let userInput = <textarea placeholder={() => !auxSmallScreen && unconscious(abortCompletion) ? "在任务结束后发送，Ctrl+Enter 立即发送" : "有事尽管问我"} className="userInput" enterkeyhint="send"
			onInput={() => {
				// Auto resize when typing
				userInput.style.height = '';
				userInput.style.height = (userInput.scrollHeight) + 'px';
			}}
			onKeyDown={(e) => {
				if (auxMainlyTouch) return;
				if (!e.isComposing && e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					submitInput(e, e.ctrlKey);
				}
			}}
		/>,
		backToBottomBtn,
		sendButton = createSendButton(attachments, submitInput);

	const blobCallback = blob => {
		if (blob) blobToAttachment(blob, attachments);
	};

	const debon = $derived(config.temporaryChat);
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
		<PendingMessageList attachments={attachments} input={userInput} items={pendingMessages} />
		<div className="query">
			<h1 className={"drag"}>松开上传</h1>
			{userInput}
			{AttachmentGallery(attachments)}
			<div className="controls">
				<div className="row hide-human">{CUSTOM_CONTROLS}</div>
				<div className="spacer" />
				<div className="row">
					<div className="dropdown">
						<button className="ri-attachment-2 btn ghost" title="添加附件" onClick={() => {
							if (auxMainlyTouch) return;
							fileInput.click()
						}}></button>
						<div className="list mid up">
							{IS_ANDROID_BUILD && <label className="ri-camera-4-fill" onClick={() => {webviewUploadImage().then(blobCallback)}}>拍摄照片</label>}
							<label className="ri-mic-fill" role="button" tabIndex={0} onClick={() => {openRecorder().then(blobCallback, () => {});}}>录制语音</label>
							<label className="ri-attachment-2" role="button" tabIndex={0} onClick={() => fileInput.click()}>选择文件</label>
						</div>
					</div>
					{sendButton}
				</div>
			</div>
		</div>
	</div>);

	DI[DID_INPUT_BOX_POSITION] = backToBottomBtn;

	const dropZone = element.lastElementChild;
	dropZone.addEventListener('dragenter', () => dropZone.classList.add('drag-over'));
	dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
	dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
	dropZone.addEventListener('drop', (e) => {
		e.preventDefault();
		dropZone.classList.remove('drag-over');
		const dt = e.dataTransfer;
		if (dt?.files.length) {
			for (const file of dt.files) blobToAttachment(file, attachments);
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
			for (const file of files) blobToAttachment(file, attachments);
		}
	});

	async function submitInput(event, forceInject) {
		if (await handleCommand(inputText, userInput)) return;

		const conv = unconscious(selectedConversation);
		if (conv && !conv.ready) return;

		if (sendButton.firstElementChild.disabled) return;

		const text = inputText.trim();
		if (text) {
			const m = messages.at(-1);
			if (cannotInsertAfter(m)) {
				const options = [];

				if (!m.error && await resolvePreset(conv).canPrefill)
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

		const content = await parseUserInput(text, attachments);

		inputText.value = '';
		userInput.style.height = '';
		attachments.length = 0;

		// Abort previous if any
		const aborter = unconscious(abortCompletion);
		if (aborter) {
			if (content) {
				injectMessages(conv, {role: 'user', content, time: Date.now(), defer: !forceInject});
				$update(pendingMessages);
				return;
			}

			if (event.key) return;

			aborter.abort();
			$update(abortCompletion);
			return;
		}

		if (content) {
			messages.push({role: 'user', content, time: Date.now()});
			scrollMessagesToBottom(true);
		}

		await ensureConversation();

		if (config.reviewMessage && content) return;
		submitUserChatMessage(true);
	}

	const io = new IntersectionObserver(([entry]) => {
		backToBottomBtn.style.display = !entry.isIntersecting ? "" : "none";
	});

	return [element, io];
}