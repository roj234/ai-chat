import * as fastmd from 'fastmd';
import {once} from "../utils/utils.js";

import 'katex/dist/katex.min.css';
import {SafeImage} from "../components/SafeImage.jsx";
import {unconscious} from "unconscious";
import {highlight} from "./highlight.js";

const customCodeRenderer = {};
/**
 *
 * @param {string} type
 * @param {function(code: string, language: string, node: HTMLElement, is_finished: boolean | undefined): void} htmlGenerator
 */
export function registerCodeBlockRenderer(type, htmlGenerator) {
	customCodeRenderer[type] = htmlGenerator;
}

const loadKatex = once(() => import('katex'));

/**
 * @param {HTMLElement} root
 * @param {Partial<{
 *     noHighlight: boolean,
 *     stream: boolean,
 *     noImage: boolean
 * }>} options
 * @return {import("better-marked").Renderer}
 * @constructor
 */
export function fmdHTMLRenderer(root, options = {}) {
	/**
	 * @type {HTMLElement[]}
	 */
	const nodes = [root];
	return {
		add_token(type, parser, __element_id) {
			let parent = nodes.at(-1);

			/** @type {HTMLElement} */
			let slot;

			switch (type) {
				case fastmd.DOCUMENT: return;
				case fastmd.BLOCKQUOTE:    slot = <blockquote />;break
				case fastmd.PARAGRAPH:     slot = <p />         ;break
				case fastmd.LINE_BREAK:    slot = <br />        ;break
				case fastmd.RULE:          slot = <hr />        ;break
				case fastmd.HEADING_1:     slot = <h1 />        ;break
				case fastmd.HEADING_2:     slot = <h2 />        ;break
				case fastmd.HEADING_3:     slot = <h3 />        ;break
				case fastmd.HEADING_4:     slot = <h4 />        ;break
				case fastmd.HEADING_5:     slot = <h5 />        ;break
				case fastmd.HEADING_6:     slot = <h6 />        ;break
				case fastmd.ITALIC_AST:
				case fastmd.ITALIC_UND:    slot = <em />        ;break
				case fastmd.STRONG_AST:
				case fastmd.STRONG_UND:    slot = <strong />    ;break
				case fastmd.STRIKE:        slot = <s />         ;break
				case fastmd.CODE_INLINE:   slot = <code />      ;break
				case fastmd.RAW_URL:
				case fastmd.LINK:          slot = <a />         ;break
				case fastmd.IMAGE:
					// 并没有写错，因为 noImage 下我不会设置 src 属性
					slot = options.noImage ? <img referrerPolicy="no-referrer" /> : <div className="safe-image loading">
						<div className="spinner"></div>
					</div>;
					break
				case fastmd.LIST_UNORDERED:
					slot = <ul/>;
					break
				case fastmd.LIST_ORDERED:  slot = <ol />        ;break
				case fastmd.LIST_ITEM:     slot = <li />        ;break
				case fastmd.CHECKBOX:      slot = <input type="checkbox" disabled />; break
				case fastmd.CODE_BLOCK: // \s{4}text
				case fastmd.CODE_FENCE: // ```type\n...\n```
					slot = <code className="hljs"></code>;
					parent = parent.appendChild(
						<pre className="code-block">
							<div className="code-header sticky">
								<span>text</span>
								<span className="buttons">
									<button className="ri-download-2-line ghost" data-action="save" title="下载代码"></button>
									<button className="ri-file-copy-line ghost" data-action="copy" title="复制代码"></button>
								</span>
							</div>
						</pre>
					);
					break
				case fastmd.TABLE:
					slot = <table/>;
					break
				case fastmd.TABLE_ROW:
					switch (parent.children.length) {
						case 0:
							parent = parent.appendChild(<thead/>)
							break;
						case 1:
							if (parser.table_align) {
								parent.querySelectorAll("th").forEach((el, index) => {
									el.align = parser.table_align[index];
								})
							}
							parent = parent.appendChild(<tbody/>)
							break;
						default:
							parent = parent.children[1];
					}
					slot = <tr />
					break
				case fastmd.TABLE_CELL:
					slot = document.createElement(parent.parentElement?.tagName === "THEAD" ? "th" : "td")
					break;

				case fastmd.EQUATION_BLOCK:
				case fastmd.EQUATION_INLINE: slot = <math />; break;
				case fastmd.HTML_ELEMENT:
					slot = document.createElement(__element_id);
					break;
				case fastmd.QUOTE:
					slot = <span className={"q"} />
			}

			nodes.push(parent.appendChild(slot));
		},
		end_token(token_id, parser, undo) {
			const node = nodes.pop();

			if (undo) {
				node.remove();
				return node._value || node.textContent;
			}

			if (token_id === fastmd.CODE_FENCE) {
				const language = node.closest("pre").lang;

				const code = node._value;
				delete node._value;

				if (!options.stream) node.textContent = code;

				const render = customCodeRenderer[language] || highlight;
				render(code, language, node, true);
			}
		},
		add_text(text, parser) {
			const node = nodes.at(-1);
			const token = parser.tokens.at(-1);
			switch (token) {
				case fastmd.IMAGE:
					this.set_attr(fastmd.TITLE, text);
					return;
				case fastmd.EQUATION_BLOCK:
				case fastmd.EQUATION_INLINE: {
					node._value = (node._value || "") + text;

					if (!node.dataset.processed) {
						node.dataset.processed = true;

						const dollar = parser.eq_dollar;
						const displayMode = token === fastmd.EQUATION_BLOCK;

						loadKatex().then((katex) => {
							const cleanFormula = node._value.replace(/\p{Script=Han}+/gu, '\\text{$&}');
							node.innerHTML = katex.renderToString(cleanFormula, {throwOnError: false, displayMode});
						}).catch(e => {
							let text = node._value;
							if (dollar) text = displayMode ? `$$\n${text}\n$$` : `$${text}$`;
							else text = displayMode ? `\\[\n${text}\n\\]` : `\\(${text}\\)`;

							const errorNode = <span className="katex-error" title={"公式渲染失败:\n"+e.message.substring(19)}>{text}</span>;
							if (displayMode) node.replaceChildren(<br/>, errorNode);
							else node.replaceChildren(errorNode);
						}).finally(() => {
							delete node.dataset.processed;
						});
					}

					return;
				}
				case fastmd.CODE_FENCE: {
					const code = node._value = (node._value || "") + text;
					if (!options.stream) return;

					let language = node.closest("pre").getAttribute("lang");
					const ccr = customCodeRenderer[language];
					if (ccr) {
						if (ccr(code, language, node, false)) {
							break;
						} else {
							return;
						}
					}

					if (options.noHighlight || highlight(code, language, node)) {
						break;
					}
					return;
				}
			}

			const lastChild = node.lastChild;
			if (lastChild?.nodeType !== Node.TEXT_NODE) node.appendChild(new Text(text));
			else lastChild.appendData(text);
		},
		set_attr(type, value) {
			const node = nodes.at(-1);

			if (type === fastmd.LANG) {
				const owner = node.closest("pre.code-block");
				let [language, filename] = value.split(":", 2);
				owner.setAttribute("lang", language);
				const span = owner.querySelector("span");
				if (filename) span.dataset.name = filename;
				span.innerText = filename || language;
			}

			if (type === fastmd.SRC && !options.noImage) {
				node.replaceWith(unconscious(<SafeImage src={value} title={node.title} />));
				return;
			}

			const name = fastmd.ATTRIBUTE_NAMES[type];
			const attr = node.attributes[name];
			if (!attr) {
				node.setAttribute(name, value);
			} else {
				attr.value += value;
			}
		}
	}
}
