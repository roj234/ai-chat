import {indexInParent} from "../utils/utils.js";
import {$foreach} from "unconscious";
import {showToast} from "./Toast.js";
import {config, selectedConversation} from "../states.js";
import {readAsString} from "/common/chardet.js";
import {formatSize} from "unconscious/common/Utils.js";

/**
 * @param {File} file
 * @param {boolean} isFileTransferWindow
 * @param {OpenAI.ContentPart[]} attachments
 */
export function blobToContentPart(file, isFileTransferWindow, attachments) {
	if (file.size > 104857600) {
		showToast("文件 " + file.name + " 过大, 仅允许100MB以内的文件", "error");
		return;
	}

	if (file.type.startsWith('image')) {
		if (!isFileTransferWindow && !config.modalities?.includes("image")) {
			showToast("模型不支持图片，无法上传 " + file.name);
			return;
		}
		attachments.push({
			type: "image_url",
			image_url: {url: file}
		});
	} else if (file.type.startsWith('audio')) {
		if (!isFileTransferWindow && !config.modalities?.includes("audio")) {
			showToast("模型不支持音频，无法上传 " + file.name);
			return;
		}
		attachments.push({
			type: "input_audio",
			input_audio: {
				data: file,
				format: file.type.slice(file.type.indexOf('/') + 1)
			}
		});
	} else if (file.type.startsWith('text')) {
		if (file.hash) {
			attachments.push({
				type: "text",
				text: file
			});
		} else {
			readAsString(file).then(text => {
				attachments.push({
					type: "text",
					text: file.size > 16384 ? new File([text], file.name, {type: file.type}) : text
				});
			})
		}
	}
}

/**
 * @param {import("unconscious").Reactive<OpenAI.ContentPart[]>} attachments
 * @return {JSX.Element}
 */
export const createFileUploader = attachments => <input type="file"
														accept="image/png,image/jpeg,image/bmp,image/gif,audio/wav,audio/mp3,audio/flac,text/plain"
														multiple onChange={({target}) => {

	const isFileTransferWindow = selectedConversation.id === 0;

	for (const file of target.files) {
		blobToContentPart(file, isFileTransferWindow, attachments);
	}

	target.value = '';
}}/>;

/**
 *
 * @param {import('unconscious').Reactive<OpenAI.ContentPart[]>} attachments
 * @return {JSX.Element}
 */
export const createAttachmentGallery = (attachments) => {
	return <div className="attachments" onClick.delegate{".attachment button"}={(e) => {
		const element = e.target.closest('.attachment');
		const index = indexInParent(element);
		attachments.splice(index, 1);
		element.remove();
	}}>{
		$foreach(attachments, (att) => {
			const DeleteBtn = <button className="delete ri-close-line"/>;

			switch (att.type) {
				case "image_url":
					return (
						<div className="attachment image-part">
							<img
								src={typeof att.image_url.url === 'string' ? att.image_url.url : att.image_url.url.toUrl()}
								alt="预览"/>
							{DeleteBtn}
						</div>
					);

				case "text":
					return (
						<div className="attachment text-part" style={"--format: \"TXT\""}>
							<div className="text-preview">
								{att.text.name + "\n"+formatSize(att.text.size)}
							</div>
							{DeleteBtn}
						</div>
					);

				case "input_audio":
					return (
						<div className="attachment audio-part"
							 style={`--format: "${att.input_audio.format}"`}>
							<div className="ri-volume-up-fill"></div>
							{DeleteBtn}
						</div>
					);
			}
		})
	}</div>;
}