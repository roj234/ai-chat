import {indexInParent} from "../utils/utils.js";
import {$foreach} from "unconscious";
import {showToast} from "./Toast.js";
import {config} from "../states.js";
import {readAsString} from "/common/chardet.js";
import {formatSize} from "unconscious/common/Utils.js";

/**
 * @param {File} file
 * @param {boolean} isFileTransferWindow
 * @param {OpenAI.ContentPart[]} attachments
 * @param {boolean} forceBlob
 */
export function blobToContentPart(file, isFileTransferWindow, attachments, forceBlob) {
	if (file.size > 104857600) {
		showToast("文件 " + file.name + " 过大, 仅允许100MB以内的文件", "error");
		return;
	}

	if (file.type.startsWith('image')) {
		if (!isFileTransferWindow && !config.modalities.includes("image")) {
			showToast("模型不支持图片，无法上传 " + file.name);
			return;
		}
		attachments.push({
			type: "image_url",
			image_url: {url: file}
		});
	} else if (file.type.startsWith('audio')) {
		if (!isFileTransferWindow && !config.modalities.includes("audio")) {
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
			// 转为UTF-8编码
			readAsString(file).then(text => {
				attachments.push({
					type: "text",
					text: forceBlob || file.size > 16384 ? new File([text], file.name, {type: file.type}) : text
				});
			})
		}
	} else {
		if (!isFileTransferWindow) {
			showToast("未知的文件类型");
			return;
		}

		attachments.push({
			type: "text",
			text: file
		});
	}
}

/** 从文件名提取扩展名 */
const extOf = (name = "") => name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "txt";

/**
 *
 * @param {import('unconscious').Reactive<OpenAI.ContentPart[]>} attachments
 * @return {JSX.Element}
 */
export const AttachmentGallery = (attachments) => {
	return <div className="attachments" onClick.delegate{".attachment button"}={(e) => {
		const element = e.target.closest('.attachment');
		const index = indexInParent(element);
		attachments.splice(index, 1);
		element.remove();
	}}>{
		$foreach(attachments, (att) => {
			const DeleteBtn = <button className="delete ri-close-line" title="移除"/>;

			switch (att.type) {
				case "image_url": {
					const file = att.image_url.url;
					const src = typeof file === 'string' ? file : file.toUrl();
					return (
						<div className="attachment image-part" title={file.name || '图片附件'}>
							<img src={src} alt="预览"/>
							{DeleteBtn}
						</div>
					);
				}

				case "text": {
					const file = att.text;
					return (
						<div className="attachment text-part" title={file.name}>
							<div className="attachment-icon"><i className="ri-file-text-line"/></div>
							<span className="format-badge">{extOf(file.name)}</span>
							<div className="attachment-meta">
								<span className="file-name">{file.name}</span>
								<span className="file-size">{formatSize(file.size)}</span>
							</div>
							{DeleteBtn}
						</div>
					);
				}

				case "input_audio": {
					const inputAudio = att.input_audio;
					return (
						<div className="attachment audio-part" title={inputAudio.data.name}>
							<div className="attachment-icon"><i className="ri-music-2-line"/></div>
							<div className="attachment-meta">
								<span className="file-name">{inputAudio.data.name}</span>
								<span className="file-size">{formatSize(inputAudio.data.size)}</span>
							</div>
							{DeleteBtn}
						</div>
					);
				}
			}
		})
	}</div>;
}