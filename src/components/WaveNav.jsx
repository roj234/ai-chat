import {$computed, $foreach} from "unconscious";

import "./WaveNav.css";
import {PASSIVE_EVENT} from "@roj234/shared";
import {VirtualList} from "unconscious/common/VirtualList.js";
import {getTextContent} from "../utils/utils.js";
import {prettyTime} from "unconscious/common/Utils.js";

const BASE_WIDTH = 10;   // 默认短横线宽度(px)
const MAX_ADD_WIDTH = 34; // 波峰最大额外伸长宽度(px)
const WAVE_RADIUS = 75;   // 正弦波影响半径(px)

const isUserMessage = item => item.key.role === 'user' && item.key.label == null;

/**
 * 正弦波浪导航条
 * @param {AiChat.MessageListItem[]} blocks
 * @param {VirtualList} messageList
 * @param {HTMLDivElement} container
 */
export const createWaveNav = (blocks, messageList, container) => {
	const userMessages = $computed(() => {
		// sanity check
		const filtered = blocks.filter(isUserMessage);
		return filtered.length > 100 ? filtered.slice(-100) : filtered;
	}, [blocks]);

	function updateSineWave(pointerY) {
		let closestIdx = -1;
		let minDistance = Infinity;

		waveNav.childNodes.forEach((item, idx) => {
			const rect = item.getBoundingClientRect();
			const itemCenterY = rect.top + rect.height / 2;
			const dist = Math.abs(pointerY - itemCenterY);
			const bar = item.firstElementChild;

			if (dist < minDistance) {
				minDistance = dist;
				closestIdx = idx;
			}

			if (dist < WAVE_RADIUS) {
				// 使用余弦函数生成平滑的钟形正弦波包络: (cos(x * π) + 1) / 2
				const ratio = dist / WAVE_RADIUS;
				const waveFactor = (Math.cos(ratio * Math.PI) + 1) / 2;
				const width = BASE_WIDTH + MAX_ADD_WIDTH * waveFactor;
				bar.style.width = `${width.toFixed(1)}px`;
			} else {
				bar.style.width = `${BASE_WIDTH}px`;
			}
			item.classList.remove('active');
		});

		// 显示波峰对应的用户消息单行预览气泡
		if (closestIdx !== -1 && minDistance < 45) {
			const activeItem = waveNav.childNodes[closestIdx];
			activeItem.classList.add('active');
			const rect = activeItem.getBoundingClientRect();

			const msg = userMessages[closestIdx].key;
			waveTooltip.replaceChildren(
				<span className="-ago">{prettyTime(msg.time)}</span>,
				getTextContent(msg)?.slice(0, 500)
			);
			waveTooltip.style.top = `${rect.top + rect.height / 2 - 16}px`;
			waveTooltip.classList.add('-show');
			return closestIdx;
		} else {
			waveTooltip.classList.remove('-show');
			return -1;
		}
	}

	function resetSineWave() {
		waveNav.childNodes.forEach(item => {
			item.firstElementChild.style.width = `${BASE_WIDTH}px`;
			item.classList.remove('active');
		});
		waveTooltip.classList.remove('-show');
	}

	function scrollToUserMsg(idx, item) {
		if (idx) item = userMessages[idx];
		messageList.scrollIntoView(
			item,
			//{ behavior: 'smooth', block: 'start' }
		);
	}

	let lastTouchedIdx = -1;
	let waveTooltip = <div className="-tooltip" />;
	let waveNav = <div className="-nav"
		onMouseMove={ev => updateSineWave(ev.clientY)}
		onMouseLeave={resetSineWave}
		onTouchStart.passive={(e) => {
			const touchY = e.touches[0].clientY;
			lastTouchedIdx = updateSineWave(touchY);
		}}
		onTouchMove.passive={(e) => {
			const touchY = e.touches[0].clientY;
			const currentIdx = updateSineWave(touchY);

			if (currentIdx !== -1 && currentIdx !== lastTouchedIdx) {
				lastTouchedIdx = currentIdx;
				scrollToUserMsg(currentIdx);
				navigator.vibrate?.(8);
			}
		}}
		onTouchEnd={() => {
			if (lastTouchedIdx !== -1) scrollToUserMsg(lastTouchedIdx);
			setTimeout(resetSineWave, 150);
		}}
	>{$foreach(userMessages, (item) => {
		return <div className='-item' _key={item} onClick={() => scrollToUserMsg(null, item)}>
			<div className="-bar" />
		</div>
	})}</div>;

	let lastItem;
	container.addEventListener('scroll', () => {
		let currentItem;
		let currentItemInvisible;

		for (let i = messageList._start; i < messageList._end; i++) {
			const item = messageList.items[i];
			if (isUserMessage(item)) {
				if (messageList.getValue(i).getBoundingClientRect().top > 0) {
					currentItem = item;
					break;
				}

				currentItemInvisible = item;
			}
		}

		currentItem ??= currentItemInvisible;
		if (currentItem == null) {
			for (let i = messageList._start - 1; i >= 0; i--) {
				const item = messageList.items[i];
				if (isUserMessage(item)) {
					currentItem = item;
					break
				}
			}
		}

		if (lastItem !== currentItem) {
			lastItem = currentItem;
			waveNav.childNodes.forEach((item) => {
				item.classList.toggle('-current', item._key === currentItem);
			});
		}
	}, PASSIVE_EVENT);

	container.append(<div className="wave-nav">{waveNav}{waveTooltip}</div>);
}

