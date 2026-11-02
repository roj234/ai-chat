import {getCurrentTheme} from "../states.js";
import {kvListGet} from "../database.js";
import {PRESET_KVS_ID} from "../presets.js";
import {debugSymbol} from "@roj234/shared";

/**
 * @type {Record<string, string | function(AiChat.Conversation): Promise<string>>}
 */
export const PLACEHOLDERS = {};

const TEMPORARY_PLACEHOLDER = debugSymbol("PlaceholderOnConversation");

/**
 *
 * @param {AiChat.Conversation} conv
 * @param {string} key
 * @param {string} val
 * @return {string}
 */
export const setPlaceholder = (conv, key, val) => (conv[TEMPORARY_PLACEHOLDER] ??= Object.create(null))[key] = val;

const pad = (n, c = 2) => String(n).padStart(c, "0");

const sanityCheck = src => {
	if (src === 'sys') throw new DOMException("不允许在系统提示词使用易变量！");
};

/**
 * @param {AiChat.Preset} cfg
 * @param {string} id
 * @param {AiChat.Conversation} conversation
 * @param {string} [src]
 */
export const resolvePlaceholder = async (id, cfg, conversation, src) => {
	switch (id) {
		case "model": return cfg.model;
		case "language": return navigator.language;
		case "theme": return getCurrentTheme();
		case "modelPrompt": return cfg.modelPrompt;
		case "time": {
			sanityCheck(src);
			const d = new Date();
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		}
		case "date": {
			sanityCheck(src);
			const d = new Date();
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		}
		case "month": {
			const d = new Date();
			return d.getFullYear()+"-"+pad(d.getMonth()+1);
		}

		case "htmlTag": {
			return cfg.allowHTMLTags.includes("basic") ? "\n- HTML tags in Markdown are supported, use HTML table for complex tables, details/summary for spoilers, and optional inline styles." : "";
		}
		default:
			if (id[0] === ':') {
				const preset = await kvListGet(PRESET_KVS_ID, id);
				return preset.systemPrompt;
			} else {
				let val = conversation[TEMPORARY_PLACEHOLDER]?.[id] ?? PLACEHOLDERS[id];
				if (val != null) {
					if (typeof val === "function")
						val = await val(conversation);
					return val;
				} else if (id[0] !== '#') {
					if (src) throw new DOMException("未知提示词变量: {{"+id+"}}");
				}
			}
	}
}
