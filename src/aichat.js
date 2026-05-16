import {$state, $unwatch, $update, $watch, appendChildren, AS_IS, isPureObject, unconscious} from 'unconscious';
import Filter from 'unconscious/common/components/Filter.jsx';
import {ConversationList, updateConversationListUI} from "./components/ConversationList.jsx";
import {getMessages, isIDB, listConversations, updateConversation} from "./database.js";
import {CUSTOM_CONTROLS, SETTINGS} from "./settings.js";
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
	resumableCompletions,
	selectedConversation,
	Shared,
	state
} from "./states.js";
import {sendUserChatMessage, statusBadge} from "./api-request.js";
import {showToast} from "./components/Toast.js";
import {handleCommand} from "./commands.js";
import {TitleEditor} from "./components/TitleEditor.jsx";

import {SettingDialog} from "./components/SettingDialog.jsx";
import {onPluginLoaded} from "/plugins/PluginRegistry.js";
import {callOnLoadHandler} from "./plugin.js";
import {createAttachmentGallery, createFileUploader} from "./components/InputAttachment.jsx";
import {createSendButton} from "./components/SendButton.jsx";
import {enableBranches} from "./utils/BranchManager.js";
import {createJsonParser} from "unconscious/common/Json.js";
import SimpleModal from "./components/SimpleModal.jsx";

const $ = sel => document.getElementById(sel);

const createApp = () => {
	/**
	 * @type {HTMLElement}
	 */
	let messagesPanel,
		userInput,
		sidebar,
		scroller,
		backToBottomBtn;

	const SettingUI = <Filter config={SETTINGS} choices={config} onChange={onSettingChanged} showTitle={isMobile} />;
	const newSettingUI = SettingDialog(SettingUI);

	/**
	 * @type CSSStyleDeclaration
	 */
	const rootStyle = document.querySelector(":root").style;

	/** @type {import("unconscious").Reactive<OpenAI.ContentPart[]>} */
	const attachments = $state([]);
	const fileInput = createFileUploader(attachments);

	const toggleSidebar = () => {
		if (!newSettingUI.style.display) jsHide(newSettingUI);
		jsHide(sidebar);
	};


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
				<button className="ri-menu-line btn ghost" title="展开侧边栏" onClick={toggleSidebar}></button>
				<TitleEditor/>
				<button className="ri-add-line btn ghost" title="开启新对话" onClick={beginConversation}></button>
			</div>
		</header>
		{newSettingUI}
		<aside ref={sidebar} className="sidebar hide" style={isMobile ? "display:none;left:-100%":undefined}>
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
				<div className="composer" class:hidden={() => config.uiAutoHideInput && lastScrollDirection.value}>
					<div className="logo">
					<span style={{
						display: "flex",
						alignItems: "flex-end",
					}}
						  dangerouslySetInnerHTML={() => config.name || "<span class='ri-ai' style='font-size:40px'></span>Chat"}></span>

						<span style={{
							height: "80px",
							color: "var(--accent)"
						}} className="ri-chat-smile-ai-fill"></span>
					</div>
					<div className={"f-controls"}>
						{statusBadge}
						<button className={"ri-arrow-down-s-line chip"} style={"display:none"} ref={backToBottomBtn} onClick={() => {
							scroller.scrollTo({
								top: scroller.scrollHeight,
								behavior: "smooth",
							})
						}} title={"返回底部"} />
					</div>
					<div className="query">
						<textarea placeholder="今天有什么能帮到你？" id="userInput" ref={userInput}
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
						{createAttachmentGallery(attachments)}
						<div className="controls">
							{CUSTOM_CONTROLS}
							<div className="spacer"></div>
							<button className="ri-attachment-2 btn ghost" title="上传附件"
									onClick={() => fileInput.click()}></button>
							{createSendButton(attachments, onSend)}
						</div>
					</div>
				</div>
			</div>
		</div>
	</>);

	bind(userInput, inputText);

	const backToBottomBtnShowHide = () => {
		const top = scroller.scrollTop;
		const b = scroller.scrollHeight - scroller.offsetHeight - top > 250;
		backToBottomBtn.style.display = b ? "" : "none";
	};
	scroller.addEventListener("scroll", backToBottomBtnShowHide);

	Shared.scroller = scroller;
	Shared.SettingUI = SettingUI;
	Shared.toggleSidebar = toggleSidebar;

	const toggleSettingUI = (id, display) => newSettingUI.showHide(id, display);

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

		if (id.endsWith("#")) {
			id = id.replaceAll(/[^a-zA-Z0-9_]/g, "");
			try {
				let data;
				if (newValue) {
					const parser = createJsonParser(AS_IS, {allowBareKey: true});
					try {
						parser.write(newValue);
						data = parser.end();
					} catch (e) {
						throw e+" near index "+parser.pos();
					}

					if (id === 'additionalBody') {
						if (!isPureObject(data)) return "只接受对象";
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
							if (!isPureObject(data)) return "只接受数组或对象";

							for (const k in data) {
								const v = data[k];
								new RegExp(k);
								// 允许为0，方便禁用
								if (typeof v !== "number" || v < 0 || v > 1)
									return "概率必须是[0,1]之间的数字";
							}
						}
					} else if (id === "stop") {
						if (!Array.isArray(data)) return "只接受字符串数组";
						for (const x of data)
							if (typeof x !== "string")
								return "只接受字符串数组";
					} else if (id === "logit_bias") {
						if (!isPureObject(data)) return "只接受对象";
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
		if (id === 'generateTitle') toggleSettingUI('title', newValue === true);
		if (id === 'canPrefill') toggleSettingUI('prefillPath', newValue === true);

		if (id === 'width') rootStyle.setProperty("--panel-width", newValue + "px");
	}

	async function onSend() {
		if (await handleCommand(inputText)) return;

		// Abort previous if any
		const aborter = unconscious(abortCompletion);
		if (aborter) {
			aborter.abort();
			return;
		}

		if (!selectedConversation.ready) {
			if (unconscious(selectedConversation)) return;

			// 创建新对话
			const conv = {
				title: "",
				time: Date.now(),
				ready: true
			};
			if (config.branchModeDefault) conv.bm_leaf = 1;
			if (config.debugDatabase) conv.id = -1;
			conversations.unshift(conv);
			selectedConversation.value = conv;
		}

		const text = inputText.trim();
		inputText.value = '';
		userInput.style.height = '';

		let input;
		// in order to generate image:
		// modalities: ['image', 'text'],

		// Syntax: 单行 ![image1]
		const imageRegex = /^!\[(?:image|attach(?:ment)?)(\d+)]$/gm;
		if (attachments.length) {
			if (config.interleavedImageTag) {
				const parts = [];
				let lastIndex = 0;
				let match;
				const usedIndices = new Set();

				// 1. 寻找匹配的标签并插入图片
				while ((match = imageRegex.exec(text)) !== null) {
					const imageIdx = parseInt(match[1], 10) - 1;

					const before = text.slice(lastIndex, match.index).trim();
					if (before) parts.push({ type: "text", text: before });

					if (attachments[imageIdx]) {
						parts.push(attachments[imageIdx]);
						usedIndices.add(imageIdx);
					} else {
						// 如果索引越界，保留原标签作为文本，或者报错
						parts.push({ type: "text", text: match[0] });
					}

					lastIndex = imageRegex.lastIndex;
				}

				const after = text.slice(lastIndex).trim();
				if (after) parts.push({ type: "text", text: after });

				attachments.forEach((attachment, index) => {
					if (!usedIndices.has(index)) parts.push(attachment);
				});

				input = parts;
			} else {
				input = [
					{
						type: "text",
						text
					},
					...attachments
				];
			}

			attachments.length = 0; // 清空附件
		} else {
			input = text || null;
		}

		if (config.uiDelaySubmit && input) {
			messages.push({role: 'user', content: input, time: Date.now()});
			return;
		}

		for (;;) {
			const result = await sendUserChatMessage(input);
			if (result !== 'tool_calls') break;
			input = null;
		}
	}

	$watch(messages, () => {
		messagesPanel.classList.toggle("no-messages", !messages.length);
	});

	return [
		App,
		() => {
			// 配置自动同步
			addEventListener("storage", (e) => {
				if (e.key === `${UC_PERSIST_STORE}:config`) queueMicrotask(() => SettingUI.sync(false, true));
			});
			SettingUI.sync(true);

			// Hash加载消息
			let id;
			const hash = location.hash.slice(1);
			if (hash.startsWith("!chat/")) {
				const id1 = parseInt(hash.slice(6));
				if (isFinite(id1)) id = id1;
			}

			listConversations().then(arr => {
				const loading = $("loading");
				loading.style.opacity = 0;
				setTimeout(() => loading.remove(), 500);
				if (!config.endpoint && !arr.length) import("./UserOnboard.js");

				conversations.value = arr;
				if (isIDB && id != null) {
					selectedConversation.value = conversations.find(t => t.id === id);
				}
			});

			if (!isIDB && id != null) {
				let lazyReplace;
				selectedConversation.value = lazyReplace = { id, ready: false };

				const updateAfterGotten = () => {
					const conversation = unconscious(selectedConversation);
					if (conversation === lazyReplace && !lazyReplace.ready) return;
					if (!conversations.length) return;

					$unwatch(selectedConversation, updateAfterGotten);
					$unwatch(conversations, updateAfterGotten);

					const index = conversations.findIndex(t => t.id === id);
					if (index >= 0) conversations[index] = lazyReplace;
				};
				$watch([selectedConversation, conversations], updateAfterGotten, false);
			}

			let prevId;
			$watch(selectedConversation, () => {
				const conv = unconscious(selectedConversation);
				if (conv && !conv.ready) {
					getMessages(conv).then(data => {
						conv.ready = true;

						if (unconscious(selectedConversation) === conv) {
							dontUpdateNextTime = conv;
							$update(selectedConversation);
							messages.value = conv.bm_leaf ? enableBranches(conv, data) : data;
						}
					}).catch(err => {
						showToast("消息读取失败\n"+prettyError(err), "error", 0);
						console.error(err);
						selectedConversation.value = null;
					});
				}

				const id = conv?.id;
				history.replaceState(null, "", id ? "#!chat/"+id : "#");

				if (conv?.ready) {
					if (prevId !== id)
						scroller.scrollToBottom();

					const resumeObj = resumableCompletions[id];
					if (resumeObj) {
						if (Date.now() - resumeObj.time < RESUME_TIMEOUT) {
							sendUserChatMessage(null);
							showToast("正在继续上次意外中断的响应", 'ok');
						} else {
							delete resumableCompletions[id];
						}
					}

					prevId = id;
				} else {
					prevId = null;
				}

				if (isMobile && !sidebar.style.display) Shared.toggleSidebar();
			});

			// autosave
			let dontUpdateNextTime;
			$watch(messages, () => {
				const skip = dontUpdateNextTime;
				dontUpdateNextTime = null;

				if (selectedConversation.ready) {
					const conv = unconscious(selectedConversation);
					if (conv === skip) return;

					const promise = updateConversation(conv, unconscious(messages));
					if (conv.id == null) {
						dontUpdateNextTime = conv;
						promise.then(() => $update(selectedConversation));
					}

					// move to front if needed
					$update(updateConversationListUI);
				}

				backToBottomBtnShowHide();
			},);

		}
	];
};

// Mount
addEventListener("load", () => {
	onPluginLoaded.then(() => {
		const [app_, onLoad_] = createApp();

		const APP = $("app");
		appendChildren(APP, app_);

		if (!isIDB && !config.db_server) {
			SimpleModal({
				type: "input",
				title: "连接数据库",
				message: [
					"请输入" + (DB_SERVER ? "用户名或" : "") + "数据库服务地址。",
					"之后也可以在设置页面修改。",
					DB_MODE === "mixed" && "你也可以点击取消，使用本地数据库。"
				].filter(Boolean).join("\n"),
				placeholder:
					(DB_SERVER ? "输入用户名（新用户将自动注册）" : "") +
					(import.meta.env.DEV ? (DB_SERVER ? "\n" : "") + "留空使用开发调试账户" : ""),
				confirmMessage: "连接",
				onConfirm(value) {
					if (!value) {
						if (import.meta.env.DEV) {
							value = "/aichat/v2/user";
							showToast("您正使用开发服务器调试账户");
						} else {
							return false;
						}
					}

					if (!value.toLowerCase().startsWith("http") && !value.startsWith("/")) {
						if (DB_SERVER) {
							value = DB_SERVER.replace("{{user}}", encodeURIComponent(value));
						} else {
							return false;
						}
					}
					config.db_server = value;
					location.reload();
				},
				onCancel(value) {
					if (DB_MODE !== 'mixed') return false;
					config.db_server = ':idb:';
					location.reload();
				}
			});
			return;
		}

		callOnLoadHandler(APP);
		onLoad_();
	});
})