import {$unwatch, $update, $watch, appendChild, appendChildren, unconscious} from 'unconscious';
import Filter from 'unconscious/common/components/Filter.jsx';
import {jsHide, prettyError} from "./utils/utils.js";
import {ConversationList, updateConversationListUI} from "./components/ConversationList.jsx";
import {SETTINGS} from "./settings.js";
import {databaseError, getMessages, isIDB, listConversations, updateConversation} from "./database.js";
import {
	beginConversation,
	config,
	conversations,
	isMobile,
	lastScrollDirection,
	messages,
	resumableCompletions,
	selectedConversation,
	Shared,
	state
} from "./states.js";
import {submitUserChatMessage} from "./api-request.js";
import {MessageList} from "./components/MessageList.jsx";
import {showToast} from "./components/Toast.js";
import {TitleEditor} from "./components/TitleEditor.jsx";
import {SettingDialog} from "./components/SettingDialog.jsx";
import SimpleModal from "./components/SimpleModal.jsx";
import {createUserInputComposer} from "./components/UserInputComposer.jsx";
import {onPluginLoaded} from "/plugins/PluginRegistry.js";
import {callOnLoadHandler} from "./plugin.js";
import {enableBranches} from "./utils/BranchManager.js";

const $ = sel => document.getElementById(sel);

const createApp = () => {
	/**
	 * @type {HTMLElement}
	 */
	let messagesPanel,
		sidebar,
		scroller;

	const SettingUI = <Filter config={SETTINGS} choices={config} onChange={onSettingChanged} showTitle={isMobile} />;
	const newSettingUI = SettingDialog(SettingUI);

	/**
	 * @type CSSStyleDeclaration
	 */
	const rootStyle = document.querySelector(":root").style;

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
		<header className={"header"} class:closed={() => !unconscious(selectedConversation)}>
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
				   href={"./docs.html"} target={"_blank"} title={"查看文档"}>爱聊天 | v{APP_VERSION}</a>
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
			</div>
		</div>
	</>);

	const [userInputComposer, backToBottomBtnShowHide] = createUserInputComposer(scroller);
	appendChild(messagesPanel, userInputComposer);

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
			toggleSettingUI('CoTPrompt', !isTextCompletion && config.reasoning === false);
		}
		if (id === 'reasoning') toggleSettingUI('CoTPrompt', newValue === false);
		if (id === 'generateTitle') toggleSettingUI('title', newValue === true);
		if (id === 'canPrefill') toggleSettingUI('prefillPath', newValue === true);
	}

	$watch(messages, () => {
		messagesPanel.classList.toggle("no-messages", !messages.length);
	});

	return [
		App,
		(app) => {
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
				if (isFinite(id1) && id1 >= 0) id = id1;
			}

			listConversations().catch(err => {
				if (err.error === "no such user") {
					connectDatabase();
				} else {
					databaseError(err);
				}
			}).then(arr => {
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
				app.classList.toggle("_human", !!conv?.noAI);
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
				history.replaceState(null, "", id != null ? "#!chat/"+id : "#");

				if (conv?.ready) {
					if (prevId !== id)
						scroller.scrollToBottom();

					const resumeObj = resumableCompletions[id];
					if (resumeObj) {
						if (Date.now() - resumeObj.time < RESUME_TIMEOUT) {
							submitUserChatMessage();
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
			});
		}
	];
};

function connectDatabase() {
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
				if (!DB_SERVER) return false;
				value = DB_SERVER + "v2/"+encodeURIComponent(value);
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
}

// Mount
addEventListener("load", () => {
	onPluginLoaded.then(() => {
		const [app_, onLoad_] = createApp();

		const APP = $("app");
		appendChildren(APP, app_);

		if (!isIDB && !config.db_server) {
			connectDatabase();
			return;
		}

		callOnLoadHandler(APP);
		onLoad_(APP);
	});
})