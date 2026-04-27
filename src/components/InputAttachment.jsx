import {indexInParent} from "../utils/utils.js";
import {$foreach} from "unconscious";

/**
 *
 * @param {import('unconscious').Reactive<OpenAI.ContentPart[]>} attachments
 * @return {JSX.Element}
 * @constructor
 */
export function _InputAttachment(attachments) {
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
								{att.text.length > 50 ? att.text.substring(0, 47) + "..." : att.text}
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