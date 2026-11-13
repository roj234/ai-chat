import {indexInParent, showImageZoomView} from "../utils/utils.js";
import {$foreach, $update} from "unconscious";
import {showToast} from "./Toast.js";
import {readAsString} from "/common/chardet.js";
import {formatSize} from "unconscious/common/Utils.js";
import {currentCombinedConfig} from "../presets.js";
import {compressImage} from "/common/imate.js";
import {config} from "../states.js";

/**
 * @param {File} file
 * @param {OpenAI.ContentPart[]} attachments
 */
export function blobToAttachment(file, attachments) {
	if (file.size > 52428800) {
		showToast("文件超过 50MB", "error");
		return;
	}

	if (file.type.startsWith('image')) {
		if (!config.modalities.includes("image")) {
			showToast("模型不支持图像输入");
			return;
		}

		const item = {
			loading: compressImage(file, currentCombinedConfig).then(blob => {
				item.image_url.url = blob;
				delete item.loading;
				$update(attachments);
			}),
			type: "image_url",
			image_url: {url: file}
		};
		attachments.push(item);
	} else if (file.type.startsWith('audio')) {
		if (!config.modalities.includes("audio")) {
			showToast("模型不支持音频输入");
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
			const item = {
				type: "text",
				text: "",
				// 转为UTF-8编码
				loading: readAsString(file).then(text => {
					item.text = new File([text], file.name, {type: file.type});
					delete item.loading;
					$update(attachments);
				})
			};
			attachments.push(item);
		}
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
	return <div className="attachments" onClick.capture.delegate{".attachment button"}.stop={(e) => {
		const element = e.target.closest('.attachment');
		const index = indexInParent(element);
		attachments.splice(index, 1);
	}}>{
		$foreach(attachments, (att) => {
			const DeleteBtn = <button className="delete ri-close-line" title="移除"/>;

			switch (att.type) {
				case "image_url": {
					const file = att.image_url.url;
					const src = typeof file === 'string' ? file : file.toUrl();
					return (
						<div className="attachment image-part" title={(file.name || '图片附件')+"\n点击放大"} onClick={e => showImageZoomView(src, file.name)}>
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
		}, att => att.loading ?? att)
	}</div>;
}