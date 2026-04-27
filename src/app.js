import {$state, $unwatch, $watch, appendChildren} from 'unconscious';
import Filter from 'unconscious/ext/components/Filter.jsx';
import {ConversationList} from "./components/ConversationList.jsx";
import {listConversations, newConversation} from "./database.js";
import {SETTINGS} from "./settings.js";
import {bind, jsHide, prettyError} from "./utils/utils.js";
import {MessageList} from "./components/MessageList.jsx";
import {
	abortCompletion,
	beginConversation,
	config,
	conversations,
	inputText,
	isMobile,
	lastScrollDirection,
	messages,
	selectedConversation,
	Shared,
	state
} from "./states.js";
import {sendUserChatMessage} from "./api-request.js";
import {showToast} from "./components/Toast.js";
import {handleCommand} from "./commands.js";
import {MobileTitleEdit} from "./components/MobileTitleEdit.jsx";

import {SettingDialog} from "./components/SettingDialog.jsx";
import {onPluginLoaded} from "/plugins/PluginRegistry.js";
import {callOnLoadHandler} from "./plugin.js";
import {_InputAttachment} from "./components/InputAttachment.jsx";

const $ = sel => document.getElementById(sel);

function createApp() {
	/**
	 * @type {HTMLElement}
	 */
	let messagesPanel,
		userInput, sendBtn,
		statusBadge, sidebar,
		thinkBtn, toolCallBtn, scroller;

	const SettingUI = <Filter config={SETTINGS} choices={config} onChange={onSettingChanged} isMobile={isMobile} />;
	const newSettingUI = SettingDialog(SettingUI);

	/**
	 * @type CSSStyleDeclaration
	 */
	const rootStyle = document.querySelector(":root").style;

	/**
	 *
	 * @type {OpenAI.ContentPart[]}
	 */
	const attachments = $state([]);

	const toggleSidebar = () => {
		if (!newSettingUI.style.display) jsHide(newSettingUI);
		jsHide(sidebar);
	};

	const fileInput = <input type="file" accept="image/png,image/jpeg,image/bmp,image/gif,audio/wav,audio/mp3,audio/flac,text/plain" multiple onChange={({target}) => {
		for (const file of target.files) {
			if (file.type.startsWith('image')) {
				attachments.push({
					type: "image_url",
					image_url: { url: file }
				});
			} else if (file.type.startsWith('audio')) {
				attachments.push({
					type: "input_audio",
					input_audio: {
						data: file,
						format: file.type.substring(file.type.indexOf('/')+1)
					}
				});
			} else if (file.type.startsWith('text')) {
				const reader = new FileReader();
				reader.onload = (e) => {
					const text = e.target.result;
					attachments.push({
						type: "text",
						text
					});
				};
				reader.readAsText(file);
			}
		}

		target.value = '';
	}} />;

	let touchStartY = 0;
	const markdownTableScrollHandler = (event) => {
		const target = event.target.closest("table");
		if (!target) return;

		const scrollLeft = target.scrollLeft;
		if (event.deltaY > 0 ? scrollLeft < target.scrollWidth - target.clientWidth : scrollLeft > 0) {
			// 阻止浏览器默认的垂直滚动行为
			event.preventDefault();

			// noinspection JSSuspiciousNameCombination
			target.scrollLeft += event.deltaY;
		}
	};

	const scrollActionHandler = (side) => {
		const top = scroller.scrollTop;
		requestAnimationFrame(() => {
			if (scroller.scrollTop !== top) {
				lastScrollDirection.value = side;
			}
		});
	};

	const App = (<>
		<header className={"header"} class:closed={() => !selectedConversation.value}>
			<div className="bar">
				<div style={"justify-self: start"}>
					<button className="ri-menu-line btn ghost" title="展开侧边栏" onClick={toggleSidebar}></button>
				</div>
				<MobileTitleEdit/>
				<div style={"justify-self: end"}>
					<button className="ri-add-line btn ghost" title="开启新对话" onClick={beginConversation}></button>
				</div>
			</div>
		</header>
		{newSettingUI}
		<aside ref={sidebar} className="sidebar hide" style={isMobile?"display:none;left:-100%":undefined}>
			<div className="sidebar-header">
				<button className="btn secondary" style="flex: 1" onClick={beginConversation}><i
					className="ri-add-line"></i>开启新对话
				</button>
				<button className="ri-arrow-left-s-line btn ghost" title="收起侧边栏" onClick={toggleSidebar}></button>
			</div>
			<ConversationList/>
			<div className="spacer"></div>
			<div className="sidebar-header">
				<a style={{fontSize: "14px", userSelect: "none", fontWeight: 700, color: "var(--text)"}}
				   href={"https://github.com/roj234/ai-chat"} target={"_blank"} title={"检查更新"}>爱聊天 | v{APP_VERSION}</a>
				<button className="ri-wrench-line btn ghost" title="设置" onClick={() => jsHide(newSettingUI)}></button>
			</div>
			<div className={"bg"} onClick={toggleSidebar}></div>
		</aside>
		<div ref={scroller} className="chat scroll"
			 onWheel.noPassive={e => {
				 lastScrollDirection.value = e.deltaY < 0;
				 markdownTableScrollHandler(e);
			 }}
			 onTouchStart.passive={e => {
				 touchStartY = e.touches[0].clientY;
			 }}
			 onTouchMove.passive={e => {
				 const touchY = e.touches[0].clientY;
				 scrollActionHandler(touchY > touchStartY)
			 }}
		>
			<div ref={messagesPanel} className="panel no-messages">
				<MessageList/>
				<div className="composer" class:hidden={() => isMobile && lastScrollDirection.value}>
					<div className="logo">
					<span style={{
						display: "flex",
						alignItems: "flex-end",
					}}
						  dangerouslySetInnerHTML={() => config.name === "default" ? "<span class='ri-ai' style='font-size:40px'></span>Chat" : config.name}></span>

						<span style={{
							height: "80px",
							color: "var(--accent)"
						}} className="ri-chat-smile-ai-fill"></span>
					</div>
					{/*我们可能很快不再需要这个了（或者仅用于调试？）*/}
					<div className="controls"><span ref={statusBadge}></span></div>
					<div className="query">
					<textarea placeholder="今天有什么能帮到你？"
							  id="userInput" ref={userInput}
							  onInput={() => {
								  // Auto resize when typing
								  userInput.style.height = '';
								  userInput.style.height = (userInput.scrollHeight) + 'px';
							  }}
							  onKeyDown={(e) => {
								  if (isMobile) return;
								  if (e.key === 'Enter' && !e.shiftKey) {
									  e.preventDefault();
									  if (!abortCompletion.value) onSend();
								  }
							  }}
					></textarea>
						<div className="controls">
							<button className="chip" class:active={() => config.think} ref={thinkBtn}
									onClick={() => {
										config.think ^= true;
									}}>
								<div className="tooltip">先思考后回答，解决复杂问题</div>
								深度思考
							</button>
							<button className="chip" class:active={() => config.tools} ref={toolCallBtn}
									onClick={() => {
										config.tools ^= true;
									}}>
								<div className="tooltip">使用工具绘制图表、进行计算</div>
								工具调用
							</button>
							<div className="spacer"></div>
							<button className="ri-attachment-2 btn ghost" title="上传附件"
									onClick={() => fileInput.click()}></button>
							<button ref={sendBtn} onClick={onSend}></button>
						</div>

					</div>
					{_InputAttachment(attachments)}
					<div className="hint"
						 style="text-align:center">{() => messages.length ? "内容由AI生成，可能包含错误，请仔细甄别" : isMobile ? "欢迎使用" : "Shift+Enter 换行"}</div>
				</div>
			</div>
		</div>
	</>);

	bind(userInput, inputText);

	Shared.scroller = scroller;
	Shared.statusBadge = statusBadge;
	Shared.SettingUI = SettingUI;
	Shared.toggleSidebar = toggleSidebar;

	function toggleSettingUI(id, display) {
		newSettingUI.showHide(id, display);
	}

	/**
	 * @typedef {Array<string> | string | number | [number, number]} SomeType
	 * @param {string} id
	 * @param {SomeType} newValue
	 * @param {Record<string, SomeType>} oldValues
	 * @return {null|string}
	 */
	function onSettingChanged(id, newValue, oldValues) {
		/*if (oldValues) {
			if (!config.name.startsWith("*")) {
				config.name = "*"+config.name;
			}
		}*/

		if (id === 'template') {
			try {
				const fn = Function("messages", "return " + (newValue || "messages.map(m => `${m.role}: ${m.content}`).join(\'\\n\\n\')"));
				fn([{role: "user",content:"a"}]).charAt(0);
				state.completionTemplate = fn;
			} catch (e) {
				if (oldValues) return e;
				showToast("无法加载提示词模板: " + prettyError(e));
			}
		}

		function betterJsonParse(str) {
			try {
				return JSON.parse(str);
			} catch (e) {
				str = str.replaceAll(/[\r\n]+/g, ",").replaceAll(/,([{},\[\]]|$)/g, (match, args) => args);

				try {
					return JSON.parse("["+str+"]");
				} catch {}

				if (str.includes(":")) {
					try {
						return JSON.parse("{"+str+"}");
					} catch {}
				}

				throw e;
			}

		}

		if (id.endsWith("#")) {
			id = id.replaceAll(/[^a-zA-Z0-9_]/g, "");
			try {
				let data;
				if (newValue) {
					data = betterJsonParse(newValue);
					if (id === 'additionalBody') {
						if (Object.prototype.toString.call(data) !== "[object Object]") return "只接受对象";
					} else if (id === 'antiSlop') {
						if (Array.isArray(data)) {
							let obj = {};
							for (const x of data) {
								new RegExp(x);
								obj[x] = 1;
								if (typeof x !== "string")
									return "只接受字符串数组";
							}
							data = obj;
						} else {
							if (Object.prototype.toString.call(data) !== "[object Object]") return "只接受数组或对象";

							for (const k in data) {
								const v = data[k];
								new RegExp(k);
								if (typeof v !== "number" || v <= 0 || v > 1)
									return "概率必须是(0,1]之间的数字";
							}
						}
					} else if (id === "stop") {
						if (!Array.isArray(data)) return "只接受字符串数组";
						for (const x of data)
							if (typeof x !== "string")
								return "只接受字符串数组";
					} else if (id === "logit_bias") {
						if (Object.prototype.toString.call(data) !== "[object Object]") return "只接受对象";
						for (const k in data) {
							const v = data[k];
							if (typeof v !== "number")
								return "概率必须是数字";
						}
					}
				}
				state[id] = data;
			} catch (e) {
				if (oldValues) return e;
				showToast(id+" 数据解析失败: " + prettyError(e));
			}
		}

		if (id === 'mode') {
			const isTextCompletion = newValue === 'completions';
			$("app").classList.toggle('tc', isTextCompletion);
			toggleSettingUI('template', isTextCompletion);
			toggleSettingUI('reasoning', !isTextCompletion);
			toggleSettingUI('CoTPrompt', !isTextCompletion && config.reasoning === false);
		}
		if (id === 'reasoning') toggleSettingUI('CoTPrompt', newValue === false);
		if (id === 'generateTitle') toggleSettingUI('titleModel', newValue === true);

		if (id === 'width') rootStyle.setProperty("--panel-width", newValue + "px");
	}

	/**
	 *
	 * @param {number} state
	 */
	function setSendBtnIcon(state) {
		const x = ["发送", "中止", "继续", "重试", "执行工具"];
		const y = ["ri-send-plane-fill", "ri-square-fill", "ri-play-large-fill", "ri-loop-right-line", "ri-function-ai-line"/* ri-check-double-line */];
		sendBtn.className = y[state]+" btn primary";
		sendBtn.title = x[state];
	}
	const button_state_map = {
		stop: 0,
		interrupt: 2,
		length: 2,
		error: 3,
		tool_calls: 4
	};

	function hasOtherSendBtnAction() {
		const value = abortCompletion.value;
		setSendBtnIcon(value ? 1 : 0);
		if (value) return true;

		const length = messages.length;
		if (!length) return false;

		/**
		 * @type {AiChat.Message}
		 */
		const last = messages[length - 1];

		if (last.role === "system") return false;

		if (last.role === "tool") {
			for (let i = length - 2; i >= 0; i--) {
				const message = messages[i];
				if (message.role === 'assistant' && message.tool_responses) {
					for (let response of message.tool_responses) {
						if (!(response.content || response.error))
							return false;
					}
					break;
				}
			}
		}

		if (last.role === 'assistant') {
			const state = button_state_map[last.finish_reason] ?? 3;
			if (!state) return false;
			setSendBtnIcon(state);
			return true;
		}

		return last.role === "user";
	}

	function onSend() {
		// Abort previous if any
		if (abortCompletion.value) {
			try {
				abortCompletion.abort();
			} catch {}
			return;
		}

		if (handleCommand(userInput)) return;

		const text = inputText.trim();
		const hasOtherAction = hasOtherSendBtnAction();
		if (!hasOtherAction && !text) return;

		if (!selectedConversation.ready) {
			if (null == selectedConversation.value) {
				newConversation().then(data => {
					conversations.unshift(data);
					if (messages.length && !selectedConversation.value) data.ready = true;
					selectedConversation.value = data;
					// 似乎有一点复制

					const listener = () => {
						if (data.ready) {
							$unwatch(selectedConversation, listener);
							if (!data.title && selectedConversation.value === data)
								onSend();
						}
					};
					$watch(selectedConversation, listener, false);
				});
			}
			return;
		}

		inputText.value = '';
		userInput.style.height = '';

		let promise;
		// in order to generate image:
		// modalities: ['image', 'text'],
		if (attachments.length) {
			promise = sendUserChatMessage([
				{
					type: "text",
					text
				},
				...attachments
			]);
			attachments.length = 0;
		} else {
			promise = sendUserChatMessage(text || null);
		}

		const repeater = result => {
			// 自动执行非交互式工具调用
			if (result === 'tool_calls') sendUserChatMessage().then(repeater);
			/*else if (result === 'stop' && isLlamaCppBackend && config.reasoning && config.prefillKVCache) {
				jsonSchemaPrefixResponse([...messages.value], "", {
					...state.additionalBody,
					max_tokens: 0,
					stream: false
				}, null);
			}*/
		};
		promise.then(repeater);
	}

	$watch([messages, abortCompletion, attachments, inputText], () => {
		sendBtn.disabled = !hasOtherSendBtnAction() && !inputText.trim() && !attachments.length;
	});

	$watch(messages, () => {
		messagesPanel.classList.toggle("no-messages", messages.length === 0);
	});

	return [
		App,
		() => {
			SettingUI.onSettingsUpdated(true);

			listConversations().then(arr => {
				const loading = $("loading");
				loading.style.opacity = 0;
				setTimeout(() => {
					loading.remove();

					if (localStorage[APP_NAME+':tour-completed'] !== APP_VERSION)
						import("./UserOnboard.js");
				}, 500);

				conversations.value = arr;

				const hash = location.hash.substring(1);
				if (hash.startsWith("!chat/")) {
					const chatId = parseInt(hash.substring(6));
					selectedConversation.value = arr.find(t => {
						return t.id === chatId;
					})
				}

				let prevId;
				$watch(selectedConversation, () => {
					const value = selectedConversation.value;
					history.replaceState(null, "", value ? "#!chat/" + value.id : "#");

					if (value?.ready) {
						if (prevId !== value.id)
							scroller.scrollToBottom();
						prevId = value.id;
					} else {
						prevId = null;
					}

					if (isMobile && !sidebar.style.display) Shared.toggleSidebar();
				});
			});
		}
	];
}

// Mount
window.addEventListener("load", () => {
	onPluginLoaded.then(() => {
		const [app_, onLoad_] = createApp();

		const APP = $("app");
		appendChildren(APP, app_);

		onLoad_();
		callOnLoadHandler(APP);
	});
})
