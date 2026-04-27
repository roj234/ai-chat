import {ContentPart, registerTools} from "/src/skills.js";
import complete from "/media/complete.js";
import {SETTINGS} from "/src/settings.js";
import {config} from "/src/states.js";
import {AudioPlayer} from "/src/components/AudioPlayer.jsx";
import {$computed, $watch} from "unconscious";
import {showToast} from "/src/components/Toast.js";
import {compressImage, jsonFetch, limitMaxSide, loadingBlock, prettyError} from "/src/utils/utils.js";
import "./txt2any.css";

import comfyui_template from '/media/comfyui_workflow.json?raw';

SETTINGS.push({
	id: "api_img_endpoint",
	_tab: "tools",
	name: "[t2a] 图像生成API (SD/Comfy)",
	type: "input",
	pattern: /^https?:\/\/.+(?:\/sdapi\/v1|\/prompt)$/,
	placeholder: "http://localhost:1/sdapi/v1"
},{
	id: "api_comfy_workflow",
	_tab: "tools",
	name: "[t2a] ComfyUI工作流",
	type: "textbox",
	placeholder: comfyui_template
},{
	id: "api_tts_endpoint",
	_tab: "tools",
	name: <>[t2a] 语音生成API<span className={"spacer"} /><a href={"https://github.com/roj234/qwen3-audio.cpp"}>服务端</a></>,
	type: "input",
	pattern: /^https?:\/\/.+(\/v1)$/,
	placeholder: "http://localhost:1/v1"
});

/**
 * 将 ComfyUI 流程模板发送至服务器并获取生成的图像 Blob
 * @param {string} endpoint
 * @param {string} template
 * @param {Record<string, any>} params
 * @returns {Promise<Blob[]>} - 返回图像的 Blob 对象
 */
function callComfyAPI(endpoint, template, params) {
	for (const name in params) {
		template = template.replaceAll("{{"+name+"}}", JSON.stringify(params[name]));
	}

	const clientId = crypto.randomUUID(); // 生成唯一客户端 ID
	const ws = new WebSocket(endpoint.replace("http", "ws")+`/ws?clientId=${clientId}`);
	ws.binaryType = 'blob';

	const promise = new Promise((resolve, reject) => {
		let promptId = null;

		ws.onopen = () => {
			jsonFetch(`${endpoint}/prompt`, {
				body: JSON.stringify({ prompt: JSON.parse(template), client_id: clientId })
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
}

/**
 * 调用 Stable Diffusion 标准 API (SDAPI) 生成图像
 * @param {string} endpoint
 * @param {Record<string, any>} params - 扩展参数对象 (例如 { negative_prompt: "...", steps: 25, cfg_scale: 7 })
 * @returns {Promise<Blob[]>} - 返回包含图像 base64 的数组
 */
async function callSDAPI(endpoint, params = {}) {
	const result = await jsonFetch(endpoint+`/txt2img`, { body: JSON.stringify(params) });
	return result.images.map(b64 => {
		const bin = atob(b64);
		const buf = new Uint8Array(bin.length);
		for (let j = 0; j < bin.length; j++) {
			buf[j] = bin.charCodeAt(j);
		}
		return new Blob([buf], { type: 'image/png' })
	});
}

function generateImage(endpoint, params) {
	if (endpoint.endsWith("/prompt")) {
		return callComfyAPI(new URL(endpoint).origin, config.api_comfy_workflow || comfyui_template, params);
	} else {
		return callSDAPI(endpoint, params);
	}
}

/**
 * 根据长宽比和基准像素计算分辨率
 * @param {string} ratioStr - 比例字符串, 如 "16:9"
 * @param {string} mpKey - 像素等级, 如 "2048x"
 * @returns {[number, number]} [width, height]
 */
function calculateResolution(ratioStr, mpKey) {
	const targetArea = Math.min(Math.pow(parseInt(mpKey), 2), 1328 * 1328); // 总像素目标

	// 2. 解析比例
	const [wRatio, hRatio] = ratioStr.split(':').map(Number);
	const ratio = wRatio / hRatio;

	// 3. 计算原始长宽
	// width / height = ratio  => width = height * ratio
	// width * height = targetArea => height * ratio * height = targetArea
	let height = Math.sqrt(targetArea / ratio);
	let width = height * ratio;

	return limitMaxSide(width, height, 2048);
}

/**
 * @type {AiChat.FunctionTool}
 */
const generate_image = {
	name: "draw_image",
	description: "根据文字描述生成图像。",
	parameters: {
		type: "object",
		properties: {
			prompt: {
				type: "string",
				minLength: 250,
				//example: "Young Chinese woman in red Hanfu, intricate embroidery. Impeccable makeup, red floral forehead pattern. Elaborate high bun, golden phoenix headdress, red flowers, beads. Holds round folding fan with lady, trees, bird. Neon lightning-bolt lamp (⚡️), bright yellow glow, above extended left palm. Soft-lit outdoor night background, silhouetted tiered pagoda (西安大雁塔), blurred colorful distant lights.",
				description: "高度详细的自然语言提示词，包含主体、环境、构图、光影及艺术风格等。",
				//example: "a fantasy creature girl with draconic features, standing in a mystical forest at twilight. her body is partially translucent with iridescent scales in shades of violet and gold, glowing faintly with bioluminescent patterns. long, flowing hair made of woven vines and glowing moss, eyes with vertical pupils glowing crimson. wearing a cloak woven from shadow and starlight, with a belt of enchanted gemstones. the environment features towering trees with glowing mushrooms, a moonlit sky with auroras, and a stream of liquid light. the lighting is soft and ethereal, with ambient glow from magical flora and fauna. the scene is detailed with textures of organic materials, glowing textures, and surreal elements. \"Mystic Guardian\" written in glowing runes on a floating stone tablet above her, positioned at the center of the frame, using a font with intricate, flowing characters",
			},
			aspect_ratio: {
				type: "string",
				pattern: "^\\d{1,2}:\\d{1,2}$",
				//example: ["1:2", "3:4", "16:9"],
				//enum: ["1:1", "3:2", "2:3", "3:4", "4:3", "16:9", "9:16"],
			},
			image_size: {
				enum: ["512", "1024", "1328", "2048"],
			},
			return_result: {
				type: "boolean",
				description: "将生成结果给你查看"
			}
		},
		required: ["prompt", "aspect_ratio", "image_size"]
	},

	script: ({ prompt, negative_prompt, aspect_ratio, image_size, return_result }, context) => {
		const [width, height] = calculateResolution(aspect_ratio, image_size);

		context.prompt = prompt;

		const seed = parseInt(Math.random().toString(36).substring(2), 36);
		return generateImage(config.api_img_endpoint, {
			batch_size: 1,
			sampler_name: "Euler",
			cfg_scale: negative_prompt ? 4 : 1,
			steps: 8, // Z-Image-Turbo SDA
			seed,
			prompt,
			negative_prompt,
			width,
			height,
		}).then(async images => {
			complete();
			context.images = images;

			const result = new ContentPart().text("Image generated");
			if (return_result) result.image(await compressImage(images[0], {maxSide: 1024}));
			return result;
		});
	},

	renderer(context, is_frozen) {
		if (context.success === false) {

		} else if (context.images) {
			return (
				<div className="generated-image">
					<img src={context.images[0].toUrl()} />
					<div className="hint">{context.prompt}</div>
					<div>{/* padding */}</div>
				</div>
			);
		} else {
			return loadingBlock("图像生成中……");
		}
	}
};

const available_voices = {};

async function updateVoices() {
	try {
		const voices = await jsonFetch(config.api_tts_endpoint+'/voices');
		if (voices.length) {
			available_voices.enum = voices.map(n => n.name);
			available_voices.description = "当前存在的音色: \n\n"+voices.map(n => n.name+": "+n.description).join("\n\n");
		} else {
			available_voices.enum = ["无"];
			available_voices.description = "当前没有音色, 请设计";
		}
	} catch (e) {
		showToast("TTS服务连接失败\n"+prettyError(e), "error");
		throw e;
	}
}

let on_tts_change;
function initVoiceService() {
	if (on_tts_change) return Promise.resolve();
	on_tts_change = $computed(() => config.api_tts_endpoint);

	return new Promise((resolve, reject) => {
		$watch(on_tts_change, () => {
			if (on_tts_change.value) resolve(updateVoices());
		});
	})
}

/**
 * @type {AiChat.FunctionTool}
 */
const generate_voice = {
	name: "text_to_speech",
	description: "将文本转换为语音",
	parameters: {
		type: "object",
		properties: {
			text: { type: "string", },
			language: {
				enum: ["Chinese", "English", "Japanese"],
				default: "Chinese"
			},
			voice: available_voices
		},
		required: ["text", "language", "voice"]
	},

	// 这个工具需要显式的用户交互
	interactive: true,
	script: async ({ text, language, voice }, context) => {
		const response = await fetch(config.api_tts_endpoint+'/audio/speech', {
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
		return '音频已生成';
	},

	renderer(context, is_frozen) {
		if (!context.audios) return loadingBlock("音频生成中……");
		return <AudioPlayer src={context.audios[0].toUrl()} autoplay={!is_frozen} />;
	},
};

/**
 * @type {AiChat.FunctionTool}
 */
const voice_design = {
	name: "voice_design",
	description: "基于文字描述设计新的音色",
	parameters: {
		type: "object",
		properties: {
			name: {
				type: "string",
				description: "音色名称"
			},
			language: {
				enum: ["Chinese", "English", "Japanese"],
				description: "该音色主要使用的语言",
				default: "Chinese"
			},
			ref_text: {
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
		required: ["name", "language", "ref_text", "instruct"]
	},

	async script({name, language, ref_text, instruct}, context) {
		const result = await jsonFetch(config.api_tts_endpoint+'/voices/create', {
			body: JSON.stringify({ name, language, ref_text, instruct })
		});

		const name1 = result.name;
		available_voices.enum.push(name1);
		available_voices.description += `\n\n${name1}: Designed: `+instruct
		return '音色 '+name1+' 创建成功！';
	}
}

registerTools("text_to_any", "生成声音、图像、视频等多媒体资源", [generate_image, generate_voice, voice_design], {
	async onActivated() {
		const tools = [];

		if (config.api_tts_endpoint) {
			try {
				await initVoiceService();
			} catch {}
			if (available_voices.enum) {
				tools.push(generate_voice, voice_design);
			}
		}

		if (config.api_img_endpoint)
			tools.push(generate_image);

		return tools;
	}
});