import {searchMessages} from "../src/database.js";

import "./search.css";
import {formatDate} from "unconscious/common/Utils.js";
import {isMobile, selectedConversation} from "../src/states.js";
import {onLoad} from "../src/plugin.js";

const searchBtn = <button className={"ri-search-line btn ghost"} title={"搜索对话"} onClick={() => {
	searchBtn.replaceWith(searchInput);
	searchInput.firstElementChild.focus();
}}></button>;

const searchInput = <div style={"position:absolute;z-index:1;background:var(--bg);width:calc(100% - 20px)"} className="input-warp">
	<input className="text-input" type="text" placeholder="关键词或语义描述" onBlur={() => {
		searchInput.replaceWith(searchBtn);
	}}
	onChange={({target}) => {
		const str = target.value;
		target.value = "";

		searchMessages(str).then(convs => {
			const handleClose = () => {
				element.remove();
			};
			const element = (
				<div className="modal-overlay" style={"background:transparent;pointer-events:none"}>
					<div className="modal" style={"pointer-events:all;"+(isMobile?"":"max-width:60vw")}
						 onClick={(e) => e.stopPropagation()}>
						<div className="header"><b>{str}的搜索结果</b>
							<button className="btn ghost" onClick={handleClose}>关闭</button>
						</div>
						<div style={"padding:0;overflow:auto"}>
							{convs?.length ? convs.map(AccordionItem) :
								<div className="no-results">没有找到相关对话</div>}
						</div>
					</div>
				</div>
			);

			document.body.append(element);
		});

		target.blur();
	}}/></div>;

onLoad((app) => {
	app.querySelector(".sidebar-header").prepend(searchBtn);
})


function AccordionItem(item) {
	let open = false;
	/** @type {HTMLElement} */
	let bodyEl, itemEl;

	const toggle = (e) => {
		e.stopPropagation();
		open = !open;
		if (open) {
			itemEl.classList.add('open');
			bodyEl.style.maxHeight = bodyEl.scrollHeight + 'px';
		} else {
			itemEl.classList.remove('open');
			bodyEl.style.maxHeight = '0px';
		}
	};

	// 相似度百分比
	const cosSim = item.messages[0]?.cossim;
	const simPercent = cosSim ? Math.round(cosSim * 100) : null;

	return (
		<div className="result-item" ref={itemEl}>
			<div className="result-header" onClick={toggle}>
				<div className="result-title">
					<span>{item.title}</span>
					{simPercent !== null ? (
						<span className="similarity">{simPercent}% 匹配</span>
					) : null}
					<button className={"btn ghost"} onClick.stop={() => {
						selectedConversation.value = {
							id: item.id,
							ready: false
						};
					}}>转到</button>
				</div>
				<span className="result-time">{formatDate('Y-m-d H:i:s', item.time)}</span>
				<svg className="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<polyline points="6 9 12 15 18 9" />
				</svg>
			</div>
			<div className="result-body" ref={bodyEl}>
				<div className="messages-container">
					{item.messages.map(msg => (
						<div className={`message ${msg.role}`} key={msg.id}>
							<span className="message-role">{msg.role === 'user' ? '你' : msg.model || msg.role}</span>
							<div className="message-bubble">{msg.content}</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}