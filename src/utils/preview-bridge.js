import SimpleModal from "../components/SimpleModal.jsx";
import {EVENT_BUS} from "../states.js";
import {$cleanup, $state} from "unconscious";
import {createJsonParser} from "@roj234/stream-json";
import {AS_IS} from "@roj234/shared";

// 一点也不优雅的降级！

/**
 * @param {string | Blob | File} src
 * @param {string} [title]
 */
export const callPreviewImage = (src, title) => {
	const makeFallback = () => {
		const fallback = <img src={typeof src === 'string' ? src : src.toUrl()} alt={src.name}/>;
		$cleanup(fallback, () => src.revokeUrl?.());

		SimpleModal({
			title: `图像预览 ${title ? `(${title})` : ""}`,
			className: "full",
			message: fallback
		})
	};

	const handled = EVENT_BUS.post(['pvi'], src, title);
	if (handled) return handled.catch(makeFallback);

	makeFallback();
};

/**
 * @param {string | Blob | File} src
 */
export const callCreateAudioPlayer = (src) => {
	const makeFallback = src => {
		const fallback = <audio controls src={typeof src === 'string' ? src : src.toUrl()}/>;
		$cleanup(fallback, () => src.revokeUrl?.());
		return fallback;
	};

	const handled = EVENT_BUS.post(['pva'], src);
	if (handled) {
		const state = $state(<div className="spin-before">加载音频播放器……</div>);
		handled.then(e => state.value = e[0], makeFallback);
		return state;
	}

	return makeFallback(src);
};

/**
 * @param {string | Blob | File} src
 */
export const callCreateVideoPlayer = (src) => {
	const makeFallback = () => {
		const fallback = <video controls src={typeof src === 'string' ? src : src.toUrl()}/>;
		$cleanup(fallback, () => src.revokeUrl?.());
		return fallback;
	};

	const handled = EVENT_BUS.post(['pvv'], src);
	if (handled) {
		const state = $state(<div className="spin-before">加载视频播放器……</div>);
		handled.then(e => state.value = e[0], makeFallback);
		return state;
	}

	return makeFallback();
};

/**
 * @param {Object} [options]
 * @return {Promise<{
 *     dom: HTMLElement,
 *     editor: {
 *         append(string): void
 *         onChange?: (string, object, string) => void
 *     },
 *     setValue(string): void
 * }>}
 */
export const callCreateEditor = (options) => {
	const makeFallback = () => {
		const err = <div className="error"/>;

		/** @type {HTMLTextAreaElement} */
		let textarea;

		const noCheck = options?.noVerify;
		const el = <textarea style="width:100%;height:100%;resize:none" spellCheck={false} readOnly={options?.readOnly}
			onInput={e => {
				let string = el.value;
				let object, content, error;

				if (noCheck) content = string;
				else {
					const parser = createJsonParser(AS_IS, {json5: true});
					try {
						parser.write(string);
						object = parser.end();
						content = string;
						error = "";
						err.value = null;
					} catch (e) {
						error = e.message;
						object = null;
					}

					err.textContent = error;
				}

				obj.onChange?.(content, object, error);
			}} onKeyDown={event => {
			if (event.key === "Tab") {
				event.preventDefault();
				textarea.setRangeText('\t', textarea.selectionStart, textarea.selectionEnd, 'end');
			}
		}}/>;
		const obj = {
			append(str) {
				el.value += str;
			},
		};

		return Promise.resolve({
			dom: [el, err],
			editor: obj,
			setValue(text) {
				el.value = text;
			}
		});
	};

	const handled = EVENT_BUS.post(['pve'], options);
	if (handled) return handled.then(e => e[0], makeFallback);

	return makeFallback();
};
