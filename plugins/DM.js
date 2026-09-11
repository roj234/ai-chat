import {getWindow, openWindow} from "../src/components/Windows.jsx";
import {EVENT_BUS} from "../src/states.js";
import {getContextStrokeColor} from "../src/components/contextColor.js";
import {$computed, $state, $vforeach, $watchWithCleanup, unconscious} from "unconscious";
import {formatDate} from "unconscious/common/Utils.js";
import {sendToSyncServer} from "../src/database/syncClient.js";
import {SYNC_DM, SYNC_DM_QUERY} from "../backend/sync.js";
import {inspect} from "unconscious/common/inspect.js";
import {COMMAND_REGISTRY} from "../src/commands.js";
import {isIDB} from "../src/database.js";

const MAX_TEXT = 1666;

function TextRing(btn, it) {
	const SIZE = 30 + 4 + 4;
	const RADIUS = 15 + 2;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // ≈ 502.65
	let bar;
	const root = <div className="ring">
		{btn}
		<svg width={SIZE} height={SIZE}>
			<defs>
				<linearGradient id="ringGradient" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="#00c6ff"/>
					<stop offset="100%" stop-color="#0072ff"/>
				</linearGradient>
			</defs>
			<circle className="track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}/>
			<circle className="bar" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} ref={bar}/>
		</svg>
	</div>;

	bar.style.strokeDasharray = CIRCUMFERENCE;
	const mc = MAX_TEXT;
	const cu = $computed(() => it.length);
	$watchWithCleanup([cu, mc], () => {
		let pct = unconscious(cu) / unconscious(mc);
		if (pct > 1) pct = 1;

		bar.style.strokeDashoffset = CIRCUMFERENCE * (1 - (pct || 0));
		bar.style.stroke = getContextStrokeColor(pct);
	});
	return root;
}

function openDMWindow(user, messages) {
	const off1 = EVENT_BUS.onoff(['dm', user], packet => {
		messages.push({
			label: packet[0],
			time: packet[1],
			content: packet[2]
		})
	});

	const win = 'chat-'+user;
	const off2 = EVENT_BUS.onoff(['closeWindow', win], () => {
		off1();
		off2();
	})

	const inputText = $state("");

	const submit = () => {
		const text = unconscious(inputText);
		if (!text) return;
		inputText.value = '';

		messages.push({
			time: Date.now(),
			content: text
		});

		sendToSyncServer(SYNC_DM, [user, text]);
	};

	return openWindow({
		id: win,
		title: "与 "+user+" 的消息",
		width: 500,
		height: 700,
		element: <>
			<div className="" style={"flex:1;margin:0 8px"}>
				{$vforeach(messages, item => {
					return <div className={"msg " + (item.label ? "other-user" : "user")}>
						<div className="role">
							<b className="stroke">{item.label ?? "你"}</b>
							<span className="time stroke">{formatDate("Y-m-d H:i:s", item.time)}</span>
							{/*<button data-action="copy" title="复制" className="ri-file-copy-line ghost"></button>*/}
						</div>
						<div className="body">
							{/*{renderMarkdownToElement(<div className="md"/>, item.content, {external: true})}*/}
							<div style={"white-space:pre-wrap"}>
								{item.content}
							</div>
						</div>
					</div>;
				})}
			</div>
			<div>
				<div className="query">
						<textarea placeholder="来聊聊天吧，暂不支持附件！" value={inputText}
								  onInput={e => inputText.value = e.target.value}
								  onKeyDown={e => {
									  if (!e.shiftKey && e.key === "Enter") {
										  submit();
										  e.preventDefault();
									  }
								  }}/>
					<div className="attachments"></div>
					<div className="controls">
						<div className="spacer"></div>
						{/*<div className="dropdown">
							<button className="ri-attachment-2 btn ghost" title="添加附件" disabled />
							<div className="list mid up">
								<label className="ri-mic-fill">录制语音</label>
								<label className="ri-attachment-2">选择文件</label>
							</div>
						</div>*/}
						{TextRing(<button className="ri-send-plane-fill btn primary" title="发送"
										  disabled={() => !unconscious(inputText) || inputText.length >= MAX_TEXT}
										  onClick={submit} />, inputText)}
					</div>
				</div>
			</div>
		</>
	})
}

function openDM(user) {
	sendToSyncServer(SYNC_DM_QUERY, user);
	const off = EVENT_BUS.onoff('dm-query', rpcRoom => {
		off();

		const messages = $state([]);

		if (rpcRoom.length) {
			messages.push({
				label: "系统",
				time: null,
				content: "对方在线，"+inspect(rpcRoom)
			});
		} else {
			messages.push({
				label: "系统",
				time: null,
				content: "对方不在线，预览版本，暂时没有消息历史和上线通知功能（后者要靠轮询，哈哈哈）"
			})
		}

		openDMWindow(user, messages);
	});
}

if (!isIDB) {
	EVENT_BUS.on(['dm'], (packet) => {
		const user = packet[0];
		if (!getWindow("dm-"+user)) {
			openDMWindow(user, $state([{
				label: packet[0],
				time: packet[1],
				content: packet[2]
			}]));
		}
	});

	COMMAND_REGISTRY['dm'] = [
		(arg) => {openDM(arg[0]);},
		'/dm <user> 向别人发送消息'
	]
}