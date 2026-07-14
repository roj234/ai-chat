import {ContentPart} from "/src/toolset.js";
import {fileAccess} from "./fileAccess.js";

const readImage = fileAccess("readRaw");

/**
 * @type {AiChat.FunctionTool}
 */
export const InspectImage = {
	name: 'InspectImage',
	description: 'Reads an image file for visual inspection. You can zoom into a specific region by providing a bounding box, which crops the image to help read small text or examine unclear details.',
	parameters: {
		type: 'object',
		properties: {
			path: { type: 'string' },
			label: {
				type: 'string',
				description: 'Name or label identifying the object within the bounding box region. Use only when a bbox is provided.'
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
				description: 'The bounding box as [x1, y1, x2, y2], normalized to a 0-1000 scale relative to the full image dimensions. (0,0) is the top-left corner.'
			}
		},
		required: ['path']
	},

	async script({ path, bbox, label }, resp, conv) {
		const isImage = path.match(/\.(png|jpg|jpeg|bmp|webp)$/i);
		if (!isImage) throw 'Unsupported format. Convert to PNG, JPG, BMP, or WebP using tools.';

		const blob = await readImage({path}, resp, conv);

		if (!bbox) {
			if (label) throw '"bbox" parameter is missing';
			return new ContentPart().image(blob);
		}

		const imgBitmap = await createImageBitmap(blob);

		let [x1, y1, x2, y2] = bbox;
		x1 = Math.round(x1 / 1000 * imgBitmap.width);
		y1 = Math.round(y1 / 1000 * imgBitmap.height);
		x2 = Math.round(x2 / 1000 * imgBitmap.width);
		y2 = Math.round(y2 / 1000 * imgBitmap.height);

		const width = x2 - x1;
		const height = y2 - y1;

		const canvas = new OffscreenCanvas(width, height);
		const ctx = canvas.getContext('2d');

		ctx.drawImage(
			imgBitmap,
			x1, y1, width, height,
			0, 0, width, height
		);

		// Blob 对象会保存在后端数据库，也许优化？
		const croppedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
		return new ContentPart().image(croppedBlob);
	}
};