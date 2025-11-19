import {$computed, $foreach, $state, $unwatch, $watch, appendChildren} from 'unconscious';
import Filter from 'unconscious/ext/components/Filter.jsx';
import {ConversationList} from "./ConversationList.jsx";
import {listConversations, newConversation} from "./idb.js";
import {SETTING_CONFIG} from "./Setting.js";
import {copyCodeEventHandler} from "./markdown-stream.js";
import {copy, Elements, jsHide, prettyError} from "./utils.js";
import {copyMessageHandler, MessageList, messagesToText, textToMessages} from "./MessageList.jsx";
import {config, conversations, messages, selectedConversation, state} from "./states.js";
import {abortCompletion, sendMessage} from "./api-request.js";
import '../assets/iconfont.css';
import {showToast} from "./Toast.js";

const $ = sel => document.querySelector(sel);

/**
 * @type {HTMLElement}
 */
let rawText, messagesPanel, rawPanel,
	userInput, messagesEl, sendBtn,
	statusBadge, sidebar, settingWrapper,
	thinkBtn, toolCallBtn, scroller, copyBtn;
/**
 * @type {Filter}
 */
let SettingUI;

/**
 * @type CSSStyleDeclaration
 */
const rootStyle = document.querySelector(":root").style;

/**
 *
 * @type {OpenAI.ContentPart[]}
 */
const attachments = $state([]);

const openSidebar = () => jsHide(sidebar);
const beginConversation = () => {
	selectedConversation.value = null;
	messages.value = [];
};

const fileInput = <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" />;

const App = (<>
	<div className="floatbar">
		<button className="btn sm ghost" title="展开侧边栏" onClick={openSidebar}><i className="i arrow-right"></i>
		</button>
		<button className="btn sm ghost" title="开启新对话" onClick={beginConversation}><i className="i plus"></i>
		</button>
	</div>
	<div ref={sidebar} className="sidebar hide">
		<div className="setting hide" style="display: none; left: -100%" ref={settingWrapper}>
			<Filter ref={SettingUI} config={SETTING_CONFIG} choices={config} onChange={onSettingChanged}></Filter>
		</div>
		<div className="sidebar-header">
			<button className="btn secondary" style="flex: 1" onClick={beginConversation}><i className="i plus"></i>开启新对话
			</button>
			<button className="btn sm ghost" title="收起侧边栏" onClick={openSidebar}><i className="i arrow-left"></i>
			</button>
		</div>
		<ConversationList></ConversationList>
		<div className="spacer"></div>
		<div className="sidebar-header">
			<h4>&copy; 2025 Roj234 | AiChat</h4>
			<button className="btn ghost" title="设置" onClick={() => {
				jsHide(settingWrapper);
			}}><i className="i settings"></i>
			</button>
		</div>
	</div>
	<div ref={scroller} className="chat scroll">
		<div ref={messagesPanel} className="panel no-messages">
			<div ref={messagesEl}>
				<MessageList></MessageList>
			</div>

			<div className="composer">
				<div className="logo">
					<svg viewBox="0 0 35 26" style="width: 70px; height: 52px">
						<path fill="var(--accent)"
							  d="M33.615 2.598c-.36-.176-.515.16-.726.33-.072.055-.132.127-.193.193-.526.562-1.14.93-1.943.887-1.174-.067-2.176.302-3.062 1.2-.188-1.107-.814-1.767-1.766-2.191-.498-.22-1.002-.441-1.35-.92-.244-.341-.31-.721-.433-1.096-.077-.226-.154-.457-.415-.496-.282-.044-.393.193-.504.391-.443.81-.614 1.702-.598 2.605.04 2.033.898 3.652 2.603 4.803.193.132.243.264.182.457-.116.397-.254.782-.376 1.179-.078.253-.194.308-.465.198-.936-.391-1.744-.97-2.458-1.669-1.213-1.173-2.31-2.467-3.676-3.48a16.254 16.254 0 0 0-.975-.668c-1.395-1.354.183-2.467.548-2.599.382-.138.133-.612-1.102-.606-1.234.005-2.364.42-3.803.97a4.34 4.34 0 0 1-.66.193 13.577 13.577 0 0 0-4.08-.143c-2.667.297-4.799 1.558-6.365 3.712C.116 8.436-.327 11.378.215 14.444c.57 3.233 2.22 5.91 4.755 8.002 2.63 2.17 5.658 3.233 9.113 3.03 2.098-.122 4.434-.403 7.07-2.633.664.33 1.362.463 2.518.562.892.083 1.75-.044 2.414-.182 1.04-.22.97-1.184.593-1.36-3.05-1.421-2.38-.843-2.99-1.311 1.55-1.834 3.918-5.093 4.648-9.531.072-.49.164-1.18.153-1.577-.006-.242.05-.336.326-.364a5.903 5.903 0 0 0 2.187-.672c1.977-1.08 2.774-2.853 2.962-4.978.028-.325-.006-.661-.35-.832ZM16.39 21.73c-2.956-2.324-4.39-3.089-4.982-3.056-.554.033-.454.667-.332 1.08.127.407.293.688.526 1.046.16.237.271.59-.161.854-.952.589-2.607-.198-2.685-.237-1.927-1.134-3.537-2.632-4.673-4.68-1.096-1.972-1.733-4.087-1.838-6.345-.028-.545.133-.738.676-.837A6.643 6.643 0 0 1 5.086 9.5c3.017.441 5.586 1.79 7.74 3.927 1.229 1.217 2.159 2.671 3.116 4.092 1.02 1.509 2.115 2.946 3.51 4.125.494.413.887.727 1.263.958-1.135.127-3.028.154-4.324-.87v-.002Zm1.417-9.114a.434.434 0 0 1 .587-.408c.06.022.117.055.16.105a.426.426 0 0 1 .122.303.434.434 0 0 1-.437.435.43.43 0 0 1-.432-.435Zm4.402 2.257c-.283.116-.565.215-.836.226-.421.022-.88-.149-1.13-.358-.387-.325-.664-.506-.78-1.073-.05-.242-.022-.617.022-.832.1-.463-.011-.76-.338-1.03-.265-.22-.603-.28-.974-.28a.8.8 0 0 1-.36-.11c-.155-.078-.283-.27-.161-.508.039-.077.227-.264.271-.297.504-.286 1.085-.193 1.623.022.498.204.875.578 1.417 1.107.553.639.653.815.968 1.295.25.374.476.76.632 1.2.094.275-.028.5-.354.638Z"></path>
					</svg>
					DeepSleep
				</div>
				<div className="controls">
					<div className="badge" ref={statusBadge}>v2.6-251119-Final</div>
					<div className="hint">提示：Shift+Enter 换行</div>
					<div className="spacer"></div>
				</div>
				<div className="query">
					<div className="beam" style="border-radius: var(--border-radius-md)"></div>
					<textarea placeholder="今天有什么可以帮到你？"
							  id="userInput" ref={userInput}
							  onInput={() => {
								  // Auto resize when typing
								  userInput.style.height = '';
								  userInput.style.height = (userInput.scrollHeight) + 'px';

								  sendBtn.disabled = !allowSendMessage() && !userInput.value.trim();
							  }}
							  onKeyDown={(e) => {
								  if (e.key === 'Enter' && !e.shiftKey) {
									  e.preventDefault();
									  if (!abortCompletion) onSend();
								  }
							  }}
					></textarea>
					<div className="controls">
						<button className="chip" class:active={$computed(() => config.think)} ref={thinkBtn}
								onClick={() => {
									config.think ^= true;
								}}>
							<div className="tooltip">先思考后回答，解决复杂问题</div>
							深度思考
						</button>
						<button className="chip" class:active={$computed(() => config.tools)} ref={toolCallBtn}
								onClick={() => {
									config.tools ^= true;
								}}>
							<div className="tooltip">使用工具绘制图表、进行计算</div>
							工具调用
						</button>
						<div className="spacer"></div>
						<button className="btn ghost i attach" title="上传图片" onClick={() => fileInput.click()}></button>
						<button className="btn" ref={sendBtn} onClick={onSend}></button>
					</div>
					<div className="attachments" onClick.delegate(".attachment button")={(e) => {
						const element = e.target.closest('.attachment');
						const index = Array.prototype.indexOf.call(element.parentElement.children, element);
						attachments.splice(index, 1);
						element.remove();
					}}>{
						$foreach(attachments, (f, i) => {
							return <div className="attachment">
								<img src={f.image_url.url} alt="附件预览"/>
								<button className="delete" type="button">×</button>
							</div>
						})
					}</div>
				</div>
				<div className="hint" style="text-align: center">尽信LLM不如无LLM</div>
			</div>
		</div>
		<div id="rawPanel" ref={rawPanel} className="panel" style="display:none;">
			<div className="row" style="justify-content: space-between">
				<div className="badge">文本视图</div>
				<button className="btn sm ghost i copy" title="复制" ref={copyBtn}
						onClick={() => copy(rawText.value, copyBtn)}></button>
			</div>
			<textarea ref={rawText} className="raw-text" placeholder="[system] ...
[user] ...
[assistant] ...
"
					  onChange={() => rawTextChanged = true}></textarea>
		</div>
	</div>
</>);

messagesEl.addEventListener("click", copyCodeEventHandler);
messagesEl.addEventListener("click", copyMessageHandler);

Elements.scroller = scroller;
Elements.messages = messagesEl;
Elements.statusBadge = statusBadge;

// Mount
appendChildren($("body"), App);


let rawTextChanged;

function updateRawText() {
	rawText.value = messagesToText(messages);
	rawTextChanged = false;
}

/**
 * @typedef {Array<string> | string | number | [number, number]} SomeType
 * @param {string} id
 * @param {SomeType} newValue
 * @param {Record<string, SomeType>} oldValues
 * @return {null|string}
 */
function onSettingChanged(id, newValue, oldValues) {
	if (id === 'edit') {
		const oldEdit = config.edit;
		if (oldEdit && !newValue && rawTextChanged) {
			try {
				messages.value = textToMessages(rawText.value || '');
				showToast('解析成功', 'ok');
			} catch (e) {
				showToast(e);
				return 'fail';
			}
		}

		messagesPanel.style.display = newValue ? 'none' : '';
		rawPanel.style.display = newValue ? '' : 'none';
		if (newValue) updateRawText();
	}

	if (id === 'template') {
		try {
			state.completionTemplate = Function("messages", "return " + (newValue || "messages => messages.map(m => `${m.role}: ${m.content}`).join(\'\\n\\n\')"));
		} catch (e) {
			if (oldValues) return e;
			showToast("无法加载提示词模板: " + prettyError(e));
		}
	}
	if (id === 'mode') {
		const displayTemplate = newValue === 'completion';
		SettingUI.querySelector("[data-id='template']").style.display = displayTemplate ? '' : 'none';
	}

	if (id === 'width') {
		rootStyle.setProperty("--panel-width", newValue + "px");
	}
}

function allowSendMessage() {
	sendBtn.innerText = abortCompletion ? "中止" : "发送";
	if (abortCompletion) return true;

	if (!messages.length) return false;
	/**
	 * @type {AiChat.Message}
	 */
	const last = messages[messages.length - 1];
	if (last.role === 'assistant') {
		if (last.finish_reason === "tool_calls") {
			sendBtn.innerText = "执行调用";
		}
		if (last.finish_reason === "length") {
			sendBtn.innerText = "继续";
		}
		if (last.finish_reason === "error") {
			sendBtn.innerText = "重试";
		}
		return last.finish_reason !== 'stop';
	}

	return true;
}

fileInput.onchange = e => {
	const file = e.target.files?.[0];
	if (!file) return;

	const reader = new FileReader();
	reader.onload = (e) => {
		const base64Url = e.target.result;
		attachments.push({
			type: "image_url",
			image_url: { url: base64Url }
		});
	};
	reader.readAsDataURL(file);

	e.target.value = '';
};

function onSend() {
	// Abort previous if any
	if (abortCompletion) {
		try {
			abortCompletion.abort();
		} catch {}
		return;
	}

	const text = userInput.value.trim();
	if (!allowSendMessage() && !text) return;

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

	userInput.value = '';
	userInput.style.height = '';

	// in order to generate image:
	// modalities: ['image', 'text'],
	if (attachments.length) {
		attachments.unshift({
			type: "text",
			text
		});
		sendMessage([...attachments]);
		attachments.length = 0;
	} else {
		sendMessage(text);
	}
}


for (const key in config.value) {
	onSettingChanged(key, config.value[key]);
}

$watch(messages, () => {
	if (config.edit) updateRawText();
	sendBtn.disabled = !allowSendMessage() && !userInput.value.trim();
	messagesPanel.classList.toggle("no-messages", messages.length === 0);
});

listConversations().then(arr => {
	const loading = $("#loading");
	loading.style.opacity = 0;
	setTimeout(() => loading.remove(), 1000);

	conversations.value = arr;

	const hash = location.hash.substring(1);
	if (hash.startsWith("!chat/")) {
		const chatId = parseInt(hash.substring(6));
		selectedConversation.value = arr.find(t => {
			return t.id === chatId;
		})
	}

	$watch(selectedConversation, () => {
		const value = selectedConversation.value;
		if (value) scroller.scrollTop = scroller.scrollHeight;
		location.href = value ? "#!chat/" + value.id : "#";
	});
});
