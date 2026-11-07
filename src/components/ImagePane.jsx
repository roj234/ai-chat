import {showImageZoomView} from "/src/utils/utils.js";
import {$state} from "unconscious";
import {formatSize} from "unconscious/common/Utils.js";
import "./ImagePane.css";

/**
 * 图像版本比对的单侧面板：显示文件在某一层（base / overlay）中的版本。
 * @param {string} variant 面板变体（base / overlay），用于着色
 * @param {string} overlay
 * @param {File|Blob|null} blob 该层中的文件；null 表示此层中不存在
 */
export const ImagePane = ({variant, overlay, blob}) => {
	const meta = $state(formatSize(blob.size));

	return <figure>
		<figcaption>
			<span className={"layer "+variant}>{overlay}</span>
			<span className="meta ellipsis">{meta}</span>
		</figcaption>
		<div>
			<img src={blob.toUrl()} alt={overlay+" 图像"}
				 onClick={() => showImageZoomView(blob.toUrl(), blob.name)}
				 onLoad={({target}) => {meta.value = `${target.naturalWidth}×${target.naturalHeight} · ${formatSize(blob.size)}`}}
				 onError={() => {meta.value = "无法解码";}}/>
		</div>
	</figure>
};