import {SETTINGS} from "../src/settings.js";
import {searchMessages} from "../src/database.js";

import "./search.css";
import {formatDate} from "unconscious/ext/Utils.js";
import {selectedConversation} from "../src/states.js";

SETTINGS.push({
	name: "搜索对话内容",
	type: "element",
	_tab: ["general", "data"],
	element: <div className="input-warp"><input className="text-input" type="text" placeholder="关键词或语义描述" onChange={({target}) => {
		const str = target.value;
		target.value = "";

		searchMessages(str).then(convs => {
			const handleClose = () => {element.remove();};
			const element = (
				<div className="modal-overlay" style={"background:transparent;pointer-events:none"}>
					<div className="modal" style={"max-width:60vw;pointer-events:all"} onClick={(e) => e.stopPropagation()}>
						<div className="header"><b>{str}的搜索结果</b>
							<button className="btn ghost" onClick={handleClose}>关闭</button>
						</div>
						<div style={"padding:0;overflow:auto"}>
							{convs?.length ? convs.map(AccordionItem) : <div className="no-results">没有找到相关对话</div>}
						</div>
					</div>
				</div>
			);

			document.body.append(element);
		});

	}} /></div>
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