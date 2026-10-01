import {ContentPart, getToolParameters, registerToolset} from "/src/toolset.js";
import complete from "/media/complete.js";
import {SETTINGS} from "/src/settings.js";
import {config} from "/src/states.js";
import {AudioPlayer} from "/src/components/AudioPlayer.jsx";
import {isPureObject} from "unconscious";
import {loadingBlock} from "/src/utils/utils.js";
import {jsonFetch} from "/common/fetch-utils.js";
import "./multimedia_generation.css";
import {DI_settings, onLoad} from "/src/hooks.js";
import {parseJson5} from "unconscious/common/Json.js";

import {compressImage, limitMaxSide} from "/common/imate.js";
import {fileAccess} from "../agent/index.js";
import {TemplateFormatter} from "/common/template-formatter.js";
import {normalizePath} from "unconscious/common/path-utils.js";
import {getCombinedPreset} from "../../src/presets.js";

/**
 * 将 ComfyUI 流程模板发送至服务器并获取生成的图像 Blob
 * @param {string} endpoint
 * @param {string} template
 * @param {Record<string, any>} params
 * @returns {Promise<Blob[]>} - 返回图像的 Blob 对象
 */
const callComfyAPI = (endpoint, template, params) => {
	for (const name in params) params[name] = JSON.stringify(params[name]);
	const prompt = JSON.parse(TemplateFormatter.format(template, params));

	const client_id = crypto.randomUUID();
	const ws = new WebSocket(endpoint.replace("http", "ws")+`/ws?clientId=${client_id}`);
	ws.binaryType = 'blob';

	const promise = new Promise((resolve, reject) => {
		let promptId = null;

		ws.onopen = () => {
			jsonFetch(`${endpoint}/prompt`, {
				body: JSON.stringify({ prompt, client_id })
			}).then(data => {
				promptId = data.prompt_id;
			}).catch(reject);
		};

		const images = [];
		ws.onmessage = async (event) => {
			// 处理字符串消息（状态更新）
			if (typeof event.data === 'string') {
				const message = JSON.parse(event.data);

				if (message.type === 'execution_success') {
					// 如果执行完成（node 为 null），则返回收集到的图片
					if (message.data.prompt_id === promptId) {
						if (images.length) {
							resolve(images);
						} else {
							reject(new Error("任务已完成但未接收到图像数据"));
						}
					}
				}
			}
			// 处理二进制消息（图像数据）
			else {
				// 根据 ComfyUI 协议，前 8 个字节是类型/格式首部
				// 对应 Python 中的 out[8:]
				images.push(new Blob([event.data.slice(8)], { type: 'image/png' }));
			}
		};

		ws.onerror = (error) => {
			reject(new Error(`WebSocket 错误: ${error.message}`));
		};
	});
	promise.finally(() => {
		ws.close();
	});
	return promise;
};

/**
 * 调用 Stable Diffusion 标准 API (SDAPI) 生成图像
 * @param {string} endpoint
 * @param {Record<string, any>} params - 扩展参数对象 (例如 { negative_prompt: "...", steps: 25, cfg_scale: 7 })
 * @returns {Promise<Blob[]>} - 返回包含图像 base64 的数组
 */
const callSDAPI = async (endpoint, params = {}) => {
	const result = await jsonFetch(endpoint+`/txt2img`, { body: JSON.stringify(params) });
	return result.images.map(b64 => {
		const bin = atob(b64);
		const buf = new Uint8Array(bin.length);
		for (let j = 0; j < bin.length; j++) {
			buf[j] = bin.charCodeAt(j);
		}
		return new Blob([buf], { type: 'image/png' })
	});
};

const generateImage = (endpoint, params) => {
	if (endpoint.endsWith("/prompt")) {
		return callComfyAPI(new URL(endpoint).origin, config.mg_img_comfy_workflow, params);
	} else {
		return callSDAPI(endpoint, params);
	}
};

/**
 * 根据长宽比和基准像素计算分辨率
 * @param {string} ratioStr - 比例字符串, 如 "16:9"
 * @param {string} mpKey - 像素等级, 如 "2048x"
 * @returns {[number, number]} [width, height]
 */
const calculateResolution = (ratioStr, mpKey) => {
	const targetArea = Math.pow(parseInt(mpKey), 2);

	// 2. 解析比例
	const [wRatio, hRatio] = ratioStr.split(':').map(Number);
	const ratio = wRatio / hRatio;

	// 3. 计算原始长宽
	// width / height = ratio  => width = height * ratio
	// width * height = targetArea => height * ratio * height = targetArea
	let height = Math.sqrt(targetArea / ratio);
	let width = height * ratio;

	return limitMaxSide(width, height, 2048);
};

const binaryWrite = fileAccess("writeRaw");

/**
 * @type {AiChat.FunctionTool}
 */
const Draw = {
	name: "Draw",
	description: "Generate image from text.",
	parameters: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				description: "高度详细的自然语言提示词，包含主体、环境、构图、光影及艺术风格等。建议至少250字",
			},
			aspectRatio: {
				type: "string",
				pattern: "^\\d{1,2}:\\d{1,2}$",
				example: ["1:1", "4:3", "16:9"],
			},
			longEdge: {
				type: "integer",
				minimum: 512,
				maximum: 2048,
			},
			saveTo: {
				type: "string",
				description: "保存目录。省略时只展示给用户和你，不落磁盘",
			},
			options: {
				type: "object",
				description: "根据要求附加。"
			}
		},
		required: ["prompt", "aspectRatio", "longEdge"]
	},

	script: ({ prompt, aspectRatio, longEdge, options, saveTo }, context, conv) => {
		const [width, height] = calculateResolution(aspectRatio, longEdge);

		const seed = parseInt(Math.random().toString(36).slice(2), 36);

		return generateImage(config.mg_img_api, {
			sampler_name: "Euler",
			cfg_scale: 1,
			steps: 8,
			negativePrompt: '',
			seed,
			prompt,
			longEdge,
			width,
			height,
			...options
		}).then(async images => {
			complete();

			// TODO 如果保存到文件，就不要再留一份Blob
			context.images = images;

			let basePath = saveTo && normalizePath(saveTo+'/'+Math.random().toString(36).slice(3, 10)).join('/');
			const result = new ContentPart();
			const blob = images[0];

			if (images.length > 1) {
				await Promise.all(images.map((blob, i) => binaryWrite({
					path: `${basePath}-${i}.png`,
					content: blob
				}, context, conv)));
				result.text("All "+images.length+" images saved to `"+basePath+"-N.png`");
			} else {
				basePath += ".png";
				await binaryWrite({
					path: basePath,
					content: blob
				}, context, conv);
				result.text("Image saved to `"+basePath+"`");
			}

			const cfg = await getCombinedPreset(conv);
			if (cfg.modalities.includes("image")) result.image(await compressImage(blob, cfg));

			return result;
		});
	},

	renderer(ctx, is_frozen, tc) {
		if (ctx.success === false) {

		} else if (ctx.images) {
			return (
				<div className="generated-image">
					<img src={ctx.images[0].toUrl()} />
					<div className="hint">{getToolParameters(ctx, tc).prompt}</div>
					<div>{/* padding */}</div>
				</div>
			);
		} else {
			return loadingBlock("图像生成中……");
		}
	}
};

/**
 * @type {AiChat.FunctionTool}
 */
const ListVoices = {
	name: "ListVoices",
	description: "List available voices",
	script: async () => {
		const voices = await jsonFetch(config.mg_tts_api+'/voices');
		return "当前存在的音色: \n\n"+voices.map(n => n.name+": "+n.description).join("\n\n");
	},
};

/**
 * @type {AiChat.FunctionTool}
 */
const Say = {
	name: "Say",
	description: "Generate speech from text",
	parameters: {
		type: "object",
		properties: {
			voice: { type: "string", },
			text: { type: "string", },
			language: {
				enum: ["Chinese", "English", "Japanese"],
				default: "Chinese"
			},
		},
		required: ["voice", "text"]
	},

	interactive: true,
	script: async ({ text, language, voice }, context) => {
		const response = await fetch(config.mg_tts_api+'/audio/speech', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				model: 'qwen3-tts',
				input: text,
				voice,
				language,
				response_format: 'ogg'
			})
		});

		if (!response.ok) {
			let message = await response.text();
			try {
				message = JSON.parse(message);
			} catch {}
			throw new Error(message);
		}

		const blob = await response.blob();
		context.audios = [blob];

		complete();
		return 'Speech generated';
	},

	renderer(context, is_frozen) {
		if (!context.audios) return loadingBlock("音频生成中……");
		return <AudioPlayer src={context.audios[0].toUrl()} autoplay={!is_frozen} />;
	},
};

/**
 * @type {AiChat.FunctionTool}
 */
const DesignVoice = {
	name: "DesignVoice",
	description: "Create new voice from text and instruction",
	parameters: {
		type: "object",
		properties: {
			name: { type: "string" },
			language: {
				enum: ["Chinese", "English", "Japanese"],
				description: "该音色主要使用的语言",
				default: "Chinese"
			},
			referenceText: {
				type: "string",
				description: "充分体现音色特征、3-5秒左右的一句能发音的话。参考示例，不包含无关描写、引号等",
				example: [
					"哥哥，你回来啦，人家等了你好久好久了，要抱抱！",
					"H-hey! You dropped your... uh... calculus notebook? I mean, I think it's yours? Maybe?"
				]
			},
			instruct: {
				type: "string",
				description: "一句简短的情感与风格指令。描述语速、语气、情感等非文字特征。参考示例，不包含无关描写",
				example: [
					"体现撒娇稚嫩的萝莉女声，音调偏高且起伏明显，营造出黏人、做作又刻意卖萌的听觉效果",
					"Speak in an incredulous tone, but with a hint of panic beginning to creep into your voice.",
					"Male, 17 years old, tenor range, gaining confidence - deeper breath support now, though vowels still tighten when nervous"
				]
			}
		},
		required: ["name", "language", "referenceText", "instruct"]
	},

	async script({name, language, referenceText, instruct}, context) {
		const result = await jsonFetch(config.mg_tts_api+'/voices/create', {
			body: JSON.stringify({ name, language, ref_text: referenceText, instruct })
		});
		return 'Voice '+result.name+' created.';
	}
}

export const registerMultimediaGeneration = () => {
	const DATALIST_ID = "DL-imageApiProvider";
	SETTINGS.push({
		id: "mg_img_api",
		_tab: "tools",
		name: "[MultimediaGeneration] v2.0 (弃用)\n\n图像生成API",
		type: "input",
		pattern: /^https?:\/\/.+(?:\/sdapi\/v1|\/prompt)$/,
		placeholder: "SD 兼容或 ComfyUI prompt API"
	},{
		id: "mg_img_comfy_workflow",
		_tab: "tools",
		name: "ComfyUI工作流模板",
		type: "textbox",
		placeholder: `使用 Export (API) 从 ComfyUI 导出的工作流 JSON 文本
必须将输出连接到 Save to WebSocket 节点
需要将宽高种子等替换为 {{width}} 占位符，列表如下:
width height
prompt negative_prompt seed
sampler_name cfg_scale steps
`,
		pattern(value) {
			if (!value.includes("SaveImageWebsocket")) return "不支持的工作流";
			let data = parseJson5(value.replaceAll(/{{[a-z_]+}}/g, "0"));
			if (!isPureObject(data)) return "必须是JSON对象";
			return [value];
		}
	},{
		id: "mg_tts_api",
		_tab: "tools",
		name: <>语音生成API<span className={"spacer"} /><a href={"https://github.com/roj234/qwen3-audio.cpp"}>服务端</a></>,
		type: "input",
		pattern: /^https?:\/\/.+(\/v1)$/,
		placeholder: "http://localhost:1/v1"
	});

	registerToolset(
		"MultimediaGeneration",
		"Generate image, audio and speech from text instructions.",
		[Draw, ListVoices, DesignVoice, Say],
		{
			depend: ['Files'],
			systemPrompt(conv) {
				let fsType = conv.fs_type;
				const tools = conv.tools;
				const activatedModules = conv.activatedModules;
				const addTools = tool => tools.add(tool.name);
				const removeTools = tool => tools.delete(tool.name);

				let prompt = '';

				const hasImageGen = config.mg_img_api;
				const imageGenTools = [Draw];
				if (hasImageGen) {
					imageGenTools.forEach(addTools);
				} else {
					imageGenTools.forEach(removeTools);
					prompt += "Image generation: not configured.\n";
				}

				const hasVoiceGen = config.mg_tts_api;
				const voiceGenTools = [ListVoices, DesignVoice, Say];
				if (hasVoiceGen) {
					voiceGenTools.forEach(addTools);
				} else {
					voiceGenTools.forEach(removeTools);
					prompt += "TTS: not configured.\n";
				}

				return prompt && ("<AIGC-info>\n"+prompt+"</AIGC-info>");
			},
		});

	onLoad(() => {
		const owner = DI_settings.byId('mg_img_api');
		owner.append(<datalist id={DATALIST_ID}>
			<option value={"http://127.0.0.1:8188/prompt"} label={"ComfyUI 默认"}/>
			<option value={"http://127.0.0.1:1234/sdapi/v1"} label={"Stable-diffusion.cpp 默认"}/>
		</datalist>);
		owner.children[0].setAttribute("list", DATALIST_ID);
	});
};
