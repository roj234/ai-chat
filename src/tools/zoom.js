import {registerTools, ContentPart} from "../skills.js";
import {messages} from "../states.js";

function listImages() {
	const images = [];

	function add_content(msg) {
		if (Array.isArray(msg.content)) {
			for (const item of msg.content) {
				if (item.type === "image_url") {
					images.push(item.image_url.url);
				}
			}
		}
	}

	for (const msg of messages) {
		add_content(msg);
		if (msg.tool_responses) {
			for (const call of msg.tool_responses) {
				add_content(call);
			}
		}
	}
	return images;
}

registerTools("zoom", "Zoom in on a specific region of an image. 可用于识别图片细节或模糊文字", [{
	name: 'zoom',
	description: 'Zoom in on a specific region of an image by cropping it based on a bounding box',
	parameters: {
		type: 'object',
		properties: {
			// unused，也许某种CoT辅助模型理解图片位置
			label: {
				type: 'string',
				description: 'The name or label of the object in the specified bounding box'
			},
			img_idx: {
				type: 'integer',
				description: 'The zero-based index of the image in the current conversation history to which this zoom applies'
			},
			bbox: {
				type: 'array',
				items: {
					type: 'integer',
					minimum: 0,
					maximum: 1000,
				},
				minItems: 4,
				maxItems: 4,
				description: 'The [x1, y1, x2, y2] coordinates. Normalized to 0-1000 scale relative to the image dimensions (0,0 is top-left)'
			}
		},
		required: ['label', 'img_idx', 'bbox']
	},

	/**
	 * 缩放并裁剪图片工具函数
	 * @param {Array<number>} bbox - [x1, y1, x2, y2]
	 * @param {number} img_idx - 图片索引
	 * @returns {Promise<string>} - 返回裁剪后的 Base64 图片
	 */
	async script({ bbox, img_idx }) {
		const images = listImages();

		const sourceBase64 = images[img_idx];
		if (!sourceBase64) throw new Error("图片"+img_idx+"不存在");

		// 1. 将 Base64 转换为 Blob，然后创建 ImageBitmap
		const blob = sourceBase64 instanceof Blob ? sourceBase64 : await (await fetch(sourceBase64)).blob();
		const imgBitmap = await createImageBitmap(blob);

		// 2. 计算目标尺寸
		let [x1, y1, x2, y2] = bbox;
		x1 = Math.round(x1 / 1000 * imgBitmap.width);
		y1 = Math.round(y1 / 1000 * imgBitmap.height);
		x2 = Math.round(x2 / 1000 * imgBitmap.width);
		y2 = Math.round(y2 / 1000 * imgBitmap.height);

		const width = x2 - x1;
		const height = y2 - y1;

		// 3. 缩放
		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');

		ctx.drawImage(
			imgBitmap,
			x1, y1, width, height,
			0, 0, width, height
		);

		// 4. 导出结果
		// 可以根据需要调整 quality (0-1)
		const croppedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });

		// 5. 将 Blob 转回 Base64 返回
		return new ContentPart().image(croppedBlob);
	}
}]);