import "./kvcache-keepalive.css"
import {$cleanup, $computed, $state, $update, unconscious} from "unconscious";
import {closeMenu, openMenu, showToast} from "/src/components/Layer.js";
import {DI, DID_INPUT_BOX_POSITION, onLoad} from "/src/hooks.js";
import {GLOBAL_SETTINGS} from "/src/settings.js";
import {EVENT_BUS, isUserMessage, LOCKED, messages, selectedConversation, VID_FAKE_LAST_USER} from "../src/states.js";
import {debugSymbol} from "@roj234/shared";
import {resolvePreset} from "/src/presets.js";
import {getImmediateMessages, getMessages} from "/src/database.js";
import {agentLoop} from "/src/api-request.js";

const LOOP_START = debugSymbol("RequestTime");
const WARMUP_DEADLINE = debugSymbol("WarmupDeadline");
const WARMUP_COUNT = debugSymbol("WarmupCount");
const WARMUP_STATE = $state();

const WarmupPill = ({conv}) => {
	const count = conv[WARMUP_COUNT];
	const scheduledTime = conv[WARMUP_DEADLINE];
	const remain = scheduledTime - Date.now();
	if (remain < 0) return;

 	const maxCount = 5;

	const SIZE = 24;
	const RADIUS = 8;
	const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

	const bar = <svg:circle className="-bar" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}/>;

	bar.style.strokeDasharray = bar.style.strokeDashoffset = CIRCUMFERENCE;

	bar.animate([
		{ strokeDashoffset: 0 },
		{ strokeDashoffset: CIRCUMFERENCE }
	], remain);

	const node = <span/>;
	const callback = () => {
		const remain = Math.ceil((scheduledTime - Date.now()) / 1000);
		if (!remain) {
			clearInterval(timer);
			delete conv[WARMUP_DEADLINE];
			$update(WARMUP_STATE);

			(async() => {
				const msgs = await getMessages(conv);
				if (conv[LOCKED]) return;

				let obj;
				if (!isUserMessage(msgs.at(-1))) {
					obj = {
						id: VID_FAKE_LAST_USER,
						role: 'user',
						content: 'Say "Hi"'
					};
					msgs.push(obj);
				}

				const result = await agentLoop(conv, msgs, { max_completion_tokens: 1, sound: false }, { noTool: true, capture: true, usage: 'keepalive' });

				if (obj) {
					const i = msgs.lastIndexOf(obj);
					msgs.splice(i, 1);
					$update(messages);
				}

				conv[WARMUP_COUNT]++;
				EVENT_BUS.post(['_keepalive'], conv);
			})();
			return;
		}

		node.textContent = remain;
		node.animate(
			[
				{transform: 'translateY(58%) scale(.7)', opacity: 0},
				{transform: 'translateY(0) scale(1)', opacity: 1}
			],
			{duration: 340, easing: 'cubic-bezier(.2,1.4,.4,1)'}
		);
	};

	callback();

	const timer = setInterval(callback, 1000);

	const el = <div className="ai-status prefill" style="gap:4px">
		<div className="ring-progress" style={`width:${RADIUS * 2 + 2}px;height:${RADIUS * 2 + 2}px`}>
			<div className="icon" />
			<svg width={SIZE} height={SIZE}>
				<circle className="-track" cx={SIZE / 2} cy={SIZE / 2} r={RADIUS}/>
				{bar}
			</svg>
		</div>
		<span>{node}s后保活... ({count} / {maxCount})</span>
		<button className="btn danger-focus ri-close-line" style="padding:4px" title="取消保活" onClick={(e) => {
			openMenu(e, DI[DID_INPUT_BOX_POSITION].closest('.scroll'), [
				{label: `缓存保活还要不要？`},
				{
					el: <div className="row" style="justify-content:center">
						<button className="btn ghost" onClick={closeMenu}>留着</button>
						<button className="btn danger" onClick={() => {
							delete conv[WARMUP_DEADLINE];
							$update(WARMUP_STATE);
							closeMenu();
						}}>不要</button>
					</div>
				}
			]);

		}} />
	</div>;

	$cleanup(el, () => clearInterval(timer));
	return el;
};

GLOBAL_SETTINGS.push({
	id: "kvCacheKeepalive",
	name: "缓存保活",
	title: "对话停止后，定时刷新几次KV缓存，只有正常结束(stop)且渲染中的对话会保活。\n在下面选择计时起点",
	_tab: "model",
	_group: "model",
	type: "radio",
	choices: {
		"响应开始": 1,
		"响应结束": 2,
		"关闭": 0,
	},
	required: true,
	default: 0
});
GLOBAL_SETTINGS.push({
	id: "kvCacheKeepalive_cnt",
	name: "保活次数",
	_tab: "model",
	_group: "model",
	type: "number",
	min: 5,
	max: 9,
	required: true,
	default: 5
});
GLOBAL_SETTINGS.push({
	id: "kvCacheKeepalive_dur",
	name: "保活间隔",
	inline: true,
	unit: "秒",
	_tab: "model",
	_group: "model",
	type: "number",
	min: 240,
	max: 720,
	step: 10,
	default: 290
});
EVENT_BUS.on(['settings', 'kvCacheKeepalive'], (newValue, ev, toggle, settings) => {
	toggle('kvCacheKeepalive_', !!newValue);
});

onLoad(() => {
	const el = DI[DID_INPUT_BOX_POSITION];
	el.parentElement.prepend(<div className="cache-warmup">{$computed(() => {
		const conv = unconscious(selectedConversation);
		return !conv?.[WARMUP_DEADLINE] ? null : <WarmupPill conv={conv}/>;
	}, [selectedConversation, WARMUP_STATE])}</div>);

	EVENT_BUS.on('loop', (conv) => {
		conv[WARMUP_COUNT] = 0;
		delete conv[WARMUP_DEADLINE];
		$update(WARMUP_STATE);
	});
	EVENT_BUS.on('loopReq', (conv) => {conv[LOOP_START] = Date.now();});

	const onLoopExit = async(conv) => {
		const opt = await resolvePreset(conv);
		if (!opt.kvCacheKeepalive) return;

		const count = opt.kvCacheKeepalive_cnt;
		if (conv[WARMUP_COUNT] >= count) {
			showToast(`对话 ${conv.title || '#'+conv.id} 的 ${count} 次缓存保活已完成`, '', 0);
			return;
		}

		const last = getImmediateMessages(conv).at(-1);
		if (last.finish_reason !== 'stop') return;

		// 网络延迟
		const networkDelay = Math.max(0, last.time - conv[LOOP_START]);

		const respTime = opt === 1 ? conv[LOOP_START] : Date.now();
		conv[WARMUP_DEADLINE] = respTime + (1000 * opt.kvCacheKeepalive_dur) - networkDelay;
		$update(WARMUP_STATE);
	};

	EVENT_BUS.on('loopExit', onLoopExit);
	EVENT_BUS.on('_keepalive', onLoopExit);
})