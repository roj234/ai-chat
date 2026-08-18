import {$computed, $update, $watch, appendChild, appendChildren, AS_IS, ONCE_EVENT, unconscious} from 'unconscious';
import Filter from 'unconscious/common/components/Filter.jsx';
import {jsHide, prettyError} from "./utils/utils.js";
import {ConversationList} from "./components/ConversationList.jsx";
import {SETTINGS} from "./settings.js";
import {databaseError, getMessages, initialize, isIDB, listConversations, updateConversation} from "./database.js";
import {
	abortCompletion,
	config,
	CONFIG_VERSION,
	conversations,
	isMobile,
	lastScrollDirectionIsUp,
	LOCKED,
	messages,
	resetConversation,
	runningConversations,
	selectedConversation,
	state,
	updateConversationListUI,
	updateConversationResumeState
} from "./states.js";
import {submitUserChatMessage} from "./api-request.js";
import {MessageList} from "./components/MessageList.jsx";
import {showToast} from "./components/Toast.js";
import {TitleEditor} from "./components/TitleEditor.jsx";
import {SettingDialog} from "./components/SettingDialog.jsx";
import SimpleModal from "./components/SimpleModal.jsx";
import {createUserInputComposer} from "./components/UserInputComposer.jsx";
import {onPluginLoaded} from "/plugins/PluginRegistry.js";
import {callOnLoadHandler, DI} from "./hooks.js";
import {enableBranches} from "./utils/BranchManager.js";
import {checkUpdate} from "../common/updater.js";
import {setAllowHTMLTags} from "./markdown/markdown.js";
import {sseFetch} from "../common/openai-api-utils.js";

const $ = sel => document.getElementById(sel);

const createApp = () => {
	/**
	 * @type {HTMLElement}
	 */
	let messagesPanel,
		sidebar,
		scroller,
		updateLink,
		resizeHandle;

	/** @type {import("unconscious/common/components/Filter").FilterInstance} */
	const settings = <Filter config={SETTINGS} choices={config} onChange={onSettingChanged} />;
	const newSettingUI = SettingDialog(settings);

	const doc = document;
	/**
	 * @type CSSStyleDeclaration
	 */
	const rootStyle = doc.querySelector(":root").style;

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
				lastScrollDirectionIsUp.value = side;
			}
		});
	};

	const virtualConversationList = <ConversationList/>;
	const App = (<>
		<header className={"header"} class:closed={() => !unconscious(selectedConversation)}>
			<div className="bar">
				<button className="ri-menu-line btn ghost" title="展开侧边栏" onClick={toggleSidebar}></button>
				<TitleEditor ref={DI.title} />
				<button className="ri-add-line btn ghost" title="开启新对话" onClick={resetConversation}></button>
			</div>
		</header>
		{newSettingUI}
		<aside ref={sidebar} className="sidebar hide" style={isMobile ? "display:none;left:-100%":undefined}>
			<div className="sidebar-header">
				<button className="btn secondary" style="flex: 1" onClick={resetConversation}><i
					className="ri-add-line"></i>开启新对话
				</button>
				<button className="ri-arrow-left-s-line btn ghost" title="收起侧边栏" onClick={toggleSidebar}></button>
			</div>
			{virtualConversationList}
			<div className="spacer"></div>
			<div className="sidebar-header">
				<a style={{fontSize: "14px", userSelect: "none", fontWeight: 700, color: "var(--text)"}}
				   ref={updateLink} target={"_blank"} title={"构建号: "+BUILD_NUMBER}>爱聊天 | v{APP_VERSION}</a>
				<button className="ri-wrench-line btn ghost" title="设置" onClick={() => jsHide(newSettingUI)}></button>
			</div>
			<div className={"bg"} onClick={toggleSidebar}></div>
			{!isMobile && <div ref={resizeHandle} className={"resize ew"} style={"right:0"}></div>}
		</aside>
		<div ref={scroller} className="chat scroll"
			 onWheel.noPassive={e => {
				 lastScrollDirectionIsUp.value = e.deltaY < 0;
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
			</div>
		</div>
	</>);

	if (!isMobile) {
		$watch($computed(() => config.sidebarWidth), () => {
			sidebar.style.width = config.sidebarWidth+"px";
		});
		resizeHandle.addEventListener("mousedown", () => {
			sidebar.classList.add("moving");
			virtualConversationList.vl.startMove();
			const onMove = event => {sidebar.style.width = Math.min(Math.max(event.clientX, 200), innerWidth * 0.5, 1024)+"px";};
			doc.addEventListener("mousemove", onMove);
			doc.addEventListener("mouseup", () => {
				doc.removeEventListener("mousemove", onMove);
				sidebar.classList.remove("moving");
				config.sidebarWidth = parseInt(sidebar.style.width);
				settings.sync(false, true);
				virtualConversationList.vl.attach(virtualConversationList, true);
			}, ONCE_EVENT);
		});
	}

	const [userInputComposer, backToBottomBtnShowHide] = createUserInputComposer(scroller);
	appendChild(messagesPanel, userInputComposer);

	const toggleSettingUI = (id, display) => newSettingUI.showHide(id, display);

	toggleSettingUI('prefillPath', false);
	/**
	 * @typedef {Array<string> | string | number | [number, number]} SomeType
	 * @param {string} id
	 * @param {SomeType} newValue
	 * @param {Record<string, SomeType>} oldValues
	 * @return {null|string}
	 */
	function onSettingChanged(id, newValue, oldValues) {
		config[CONFIG_VERSION] = (config[CONFIG_VERSION] || 0) + 1;
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
		if (id === 'width') rootStyle.setProperty("--panel-width", newValue + "px");

		if (id === 'mode') {
			const isTextCompletion = newValue === 'completions';
			$("app").classList.toggle('tc', isTextCompletion);
			toggleSettingUI('template', isTextCompletion);
			toggleSettingUI('reasoning', !isTextCompletion);
			toggleSettingUI('canPrefill', !isTextCompletion);
			toggleSettingUI('forceThink', !isTextCompletion);
			toggleSettingUI('modalities', !isTextCompletion);
			toggleSettingUI('jsonSupport', !isTextCompletion);
			toggleSettingUI('prefillPath', !isTextCompletion && config.canPrefill);
			toggleSettingUI('CoTPrompt', !isTextCompletion && config.reasoning === false);
		}
		if (id === 'reasoning') toggleSettingUI('CoTPrompt', !newValue);
		if (id === 'generateTitle') toggleSettingUI('title', !!newValue);
		if (id === 'canPrefill') toggleSettingUI('prefillPath', !!newValue);
		if (id === 'messageTheme') {
			const el = messagesPanel.querySelector('._vl');
			el.className = '_vl msg-vl '+newValue;
		}
	}

	$watch(messages, () => {
		messagesPanel.classList.toggle("no-messages", !messages.length);
	});

	return [
		App,
		settings,
		scroller,
		(app) => {
			// 配置自动同步
			addEventListener("storage", (e) => {
				if (e.key === `${UC_PERSIST_STORE}:config`) queueMicrotask(() => settings.sync(false, true));
			});
			settings.sync(true);

			if (config.checkUpdate) {
				checkUpdate().then((info) => {
					if (info.hasUpdate) {
						updateLink.href = info.releaseUrl;
						updateLink.title = "下载更新";
						updateLink.append(<sup title={"发布时间: "+info.publishedAt} style={"color:red"}>*v{info.latestVersion}已可用</sup>);
					}
				});
			}

			// Hash加载消息
			let id;
			const hash = location.hash.slice(1);
			if (hash.startsWith("!chat/")) {
				const id1 = parseInt(hash.slice(6));
				if (isFinite(id1) && id1 >= 0) id = id1;
			}

			listConversations(null).catch(err => {
				if (err.error === "no such user") {
					connectDatabase();
				} else if (err.status === 401) {
					return executeLogin();
				} else {
					databaseError(err);
				}
			}).then(arr => {
				const loading = $("loading");
				loading.classList.add("exiting");
				loading.addEventListener("animationend", () => loading.remove());

				if (!arr) return;

				if (!config.endpoint && !arr.length) import("./UserOnboard.js");

				conversations.value = arr;
				if (isIDB && id != null) {
					selectedConversation.value = conversations.find(t => t.id === id);
				}
			});

			let hookGetMessages = AS_IS;

			if (!isIDB) {
				// 只有远程数据库存在这个函数
				const wsConnected = initialize();

				// batch 优化 对话和消息放在同一个响应里
				if (id != null) {
					const stub = { id, ready: false };
					selectedConversation.value = stub;

					hookGetMessages = async (promise) => {
						hookGetMessages = AS_IS;

						const messages = await promise;

						const index = conversations.findIndex(t => t.id === id);
						if (index >= 0) conversations[index] = stub;

						// 等待同步服务下发 LOCKED 对象
						await wsConnected;
						return messages;
					};
				}

				$watch([updateConversationResumeState], () => {
					const conv = unconscious(selectedConversation);
					if (conv?.[LOCKED] && conv.resumeId && !runningConversations.has(conv.id)) {
						submitUserChatMessage();
					}
				})
			}

			let prevId;
			$watch(selectedConversation, () => {
				const conv = unconscious(selectedConversation);
				const id = conv?.id;
				app.classList.toggle("_fileUI", !!conv?.noAI);

				if (conv && !conv.ready) {
					if (prevId !== id) messages.value = [];

					if (id == null) {
						conv.ready = true;
						return
					}

					hookGetMessages(getMessages(conv)).then(data => {
						conv.ready = true;

						if (unconscious(selectedConversation) === conv) {
							$update(selectedConversation);
							messages.value = conv.bm_leaf ? enableBranches(conv, data) : data;
							scroller.scrollToBottom();
						}
					}).catch(err => {
						showToast("消息读取失败\n"+prettyError(err), "error", 0);
						console.error(err);
						selectedConversation.value = null;
					});
				}

				history.replaceState(null, "", id != null ? "#!chat/"+id : "#");

				if (conv?.ready) {
					if (prevId !== id && !runningConversations.has(conv.id) && conv.resumeId) {
						if (conv[LOCKED]) {
							submitUserChatMessage();
						} else if (Date.now() - conv.time < RESUME_TIMEOUT) {
							submitUserChatMessage();
							showToast("尝试继续意外中断的请求", 'ok');
						} else {
							delete conv.resumeId;
							updateConversation(conv);
						}
					}

					prevId = id;
				} else {
					prevId = null;
				}

				if (isMobile && !sidebar.style.display) toggleSidebar();
			});

			// autosave
			$watch(messages, () => {
				if (selectedConversation.ready) {
					const conv = unconscious(selectedConversation);
					if (unconscious(abortCompletion)) return;

					const time = conv.time;
					const promise = updateConversation(conv, unconscious(messages));
					// insert new record
					if (conv.id == null) promise.then(() => $update(selectedConversation));
					// move to front
					if (time !== conv.time) $update(updateConversationListUI);
				}

				backToBottomBtnShowHide();
			});

			$watch($computed(() => config.allowHTMLTags), () => {
				setAllowHTMLTags(config.allowHTMLTags);
			})
		}
	];
};

const executeLogin = () => new Promise((resolve, reject) => {
	const abort = new AbortController;
	let modal;
	sseFetch(config.db_server+"login", { signal: abort.signal }, ({code, token}) => {
		if (code) {
			modal = SimpleModal({
				title: "交互式登录",
				message: "在服务端输入\n    /accept "+code+"\n以登录",
				onCancel: null,
				confirmMessage: "取消",
				accent: "danger",
				onConfirm() {abort.abort();}
			})
		}
		if (token) {
			config.db_pat = token;
			setTimeout(() => location.reload());
		}
	}).catch((err) => {
		modal?.remove();
		if (err.name !== 'AbortError')
			showToast("登录失败\n"+prettyError(err), 'error', 0);
		resolve();
	});
});

const connectDatabase = async () => {
	let apiEndpoint;
	try {
		const resp = await fetch(location.href, { method: "HEAD" });
		apiEndpoint = resp.headers.get('X-AiChat-API')
	} catch {}
	if (import.meta.env.DEV && !apiEndpoint) apiEndpoint = '/api/';

	SimpleModal({
		type: "input",
		title: "连接数据库",
		message: `请输入${apiEndpoint ? "用户名" : "数据库服务地址"}。` + (DB_MODE === "mixed" && "\n点击取消使用本地数据库。"),
		placeholder: (apiEndpoint ? "输入用户名（新用户将自动注册）" : ""),
		confirmMessage: "连接",
		onConfirm(value) {
			let pat;
			[value, pat] = value.trim().split("@");

			if (!value.toLowerCase().startsWith("http") && !value.startsWith('/')) {
				if (!apiEndpoint) return false;
				value = apiEndpoint + "v2/"+encodeURIComponent(value);
			}
			if (!value.endsWith('/')) value += '/';
			config.db_server = value;
			if (pat) config.db_pat = pat;
			config._new = true;
			location.reload();
		},
		onCancel(value) {
			if (DB_MODE !== 'mixed') return false;
			config.db_server = ':idb:';
			config._new = true;
			location.reload();
		}
	});
};

// Mount
addEventListener("load", () => {
	onPluginLoaded.then(() => {
		const [app, settings, messageContainer, onLoad_] = createApp();

		const wrapper = $("app");
		appendChildren(wrapper, app);

		if (!isIDB && !config.db_server) {
			connectDatabase();
			return;
		}

		callOnLoadHandler(wrapper, settings, messageContainer);
		onLoad_(wrapper);
	}).catch(e => {
		SimpleModal({
			title: "系统加载失败",
			message: prettyError(e),
			confirmMessage: "禁用所有插件",
			onCancel() {
				config.pluginOrder = [];
				location.reload();
			}
		})
	});
});

addEventListener('beforeprint', e => {
	const chat = document.querySelector(".chat");
	chat.classList.add('print');
	chat.vl.resize();
	chat.lastElementChild.append(<div style={'display:flex;justify-content:center'}>包含AI生成内容，请仔细甄别。</div>);
});
addEventListener('afterprint', e => {
	const chat = document.querySelector(".chat");
	chat.classList.remove('print');
	chat.lastElementChild.lastElementChild.remove();
});


addEventListener("unhandledrejection", e => {
	e.promise.catch(e => {
		if (typeof e === 'string') return;
		showToast("未捕获的异常\n"+prettyError(e), 'error', 0);
	})
});
