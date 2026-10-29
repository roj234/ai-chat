import './thinking-slider.css';
import {$cleanup, $computed, $derived, $watchWithCleanup, AS_IS, ref, unconscious} from "unconscious";
import {DI_settings, onLoad} from "/src/hooks.js";
import {config, selectedConversation} from "/src/states.js";
import {currentCombinedConfig, markCombinedPresetDirty, maxTokensClamped} from "/src/presets.js";
import {updateConversation} from "/src/database.js";
import {CUSTOM_CONTROLS} from "/src/customControls.js";

const BUDGET_DESCRIPTIONS = [
	'短路径推理，优先获得可用答案。',
	'给分析与验证留出更充足的预算。',
	'展开多步推演，允许更充分的探索与自检。'
];
const LANE_COUNT = 11;
const CENTER_LANE = (LANE_COUNT - 1) / 2;
const GRID_SPACING = 24;
const SAMPLE_SPACING = 3;

const smoothstep = value => value * value * (3 - 2 * value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const ThinkingSlider = ({ options, onChange, onInput, haptics = true, noAnimation }) => {
	let sliderValue = 0;
	let visible = false;
	let settings;
	let levels;

	let _width, _height;

	let description = ref(), canvas = ref(), control = ref(), input = ref(), ticks = ref(), labels = ref();
	let budgetValue = ref();
	const signalBars = [3,5,7,10].map(i => <i style={"height:"+i+"px"}/>);

	const root = (<div className="ts slider">
		<div className="description-row">
			<span className="signal" aria-hidden="true">{signalBars}</span>
			<p className="description" id="description" ref={description} />
		</div>

		<div className="trace" aria-hidden="true">
			<canvas ref={canvas} />
		</div>

		<div className="control" ref={control}>
			<div className="ticks" aria-hidden="true" ref={ticks}/>
			<input
				type="range"
				aria-label="思考强度" aria-describedby="description"
				ref={input}
				onInput={event => {
					syncSlider(event.currentTarget.valueAsNumber);
					onInput?.(uiValue);
				}}
				onChange={event => onChange?.(uiValue)}
				onPointerDown={event => vibrate(5)}
			/>
			<div className="fill"/>
		</div>

		<div className="labels" ref={labels} onClick={(event) => {
			const button = event.target.closest('[data-index]');
			if (!button) return;
			syncSlider(Number(button.dataset.index));
			onChange?.(uiValue);
		}} />
	</div>);

	const ro = new ResizeObserver(entries => {
		let { width, height } = entries[0].contentRect;

		const pixelRatio = Math.min(devicePixelRatio || 1, 2);
		_width = width;
		_height = height;
		canvas.width = Math.round(width * pixelRatio);
		canvas.height = Math.round(height * pixelRatio);

		_measureBudgetWidth();
		if (!_width) stopAnimation();
		else if (visible) startAnimation();
	});
	const io = new IntersectionObserver(entries => {
		visible = entries.at(-1).isIntersecting;
		if (visible && _width) startAnimation();
		else stopAnimation();
	});


	// ── 挂载、卸载与属性更新 ─────────────────────────────────

	$cleanup(root, () => {
		stopAnimation();
		ro.disconnect();
		io.disconnect();
	});

	// ── 配置校验与数值转换 ───────────────────────────────────

	let uiValue;

	const syncSlider = (value) => {
		const val = levels ? levels[value].value : value;
		if (val === uiValue) return;

		updateView(val);
		hapticFeedback(uiValue, val);
		uiValue = val;
	}

	const updateView = (value) => {
		if (levels) {
			let index = levels.findIndex(level => level.value === value);
			if (index < 0) index = Math.round(levels.length / 2);

			sliderValue = levels.length <= 1 ? 0.5 : index / (levels.length - 1);
			input.value = index;

			description.textContent = levels[index].description;
			input.setAttribute('aria-valuetext', levels[index].label);

			const buttons = labels.childNodes;
			const manyLevels = levels.length > 5;
			buttons.forEach((button, i) => {
				const selected = index === i;
				button.classList.toggle('chosen', selected);
				button.setAttribute('aria-pressed', String(selected));
				if (manyLevels) button.hidden = i !== 0 && i !== buttons.length - 1 && !selected;
			});

			// 当前项靠近端点时让出空间，避免三个标签在窄屏互相盖住。
			if (manyLevels && index > 0 && index < buttons.length - 1) {
				if (index / (buttons.length - 1) < .25) buttons[0].hidden = true;
				if (index / (buttons.length - 1) > .75) buttons[buttons.length - 1].hidden = true;
			}
		} else {
			sliderValue = (value - settings.min) / (settings.max - settings.min);
			input.value = value;

			const budgetText = `${value} tokens`;
			budgetValue.textContent = budgetText;
			input.setAttribute('aria-valuetext', budgetText);
			const descriptionIndex = sliderValue < .3 ? 0 : sliderValue < .7 ? 1 : 2;
			description.textContent = BUDGET_DESCRIPTIONS[descriptionIndex];
			_measureBudgetWidth();
		}

		root.style.setProperty('--p', `${sliderValue * 100}%`);
		signalBars.forEach((bar, index) => {
			bar.classList.toggle('on', index <= Math.round(sliderValue * 3));
		});
	}

	const _measureBudgetWidth = () => {
		if (levels) return;
		labels.style.setProperty('--half', `${budgetValue.offsetWidth / 2}px`);
	}

	// 震动反馈

	let _hapticBucket = null;

	const vibrate = (pattern) => {
		if (!haptics) return;
		try {
			navigator.vibrate?.(pattern);
		} catch {}
	}

	const hapticFeedback = (previous, next) => {
		// 撞到两端：双脉冲，手感上能听出“到底了”。
		if (next === 0 || next === (settings.max??settings.levels.length-1)) return vibrate([7, 18, 7]);
		// 挡位模式：每换一挡给一次短震。
		if (levels) return vibrate(12);
		// 连续模式没有离散刻度，按 1/32 量程算一个触感台阶。
		const bucket = Math.round(sliderValue * 32);
		if (bucket === _hapticBucket) return;
		_hapticBucket = bucket;
		vibrate(7);
	}

	// 阻尼动画

	let _phase1 = 0, _phase2 = 0, _phase3 = 0;

	const drawThinkingTrace = (canvas, intensity, margin = 22) => {
		const context = canvas.getContext('2d');

		const centerY = _height / 2;
		const verticalScale = _height / 90;

		context.setTransform(canvas.width / _width, 0, 0, canvas.height / _height, 0, 0);
		context.clearRect(0, 0, _width, _height);

		// 极淡的背景刻度。
		context.strokeStyle = '#ffffff06';
		context.lineWidth = 1;
		for (let x = 12; x < _width; x += GRID_SPACING) {
			context.beginPath();
			context.moveTo(x, _height * .12);
			context.lineTo(x, _height * .9);
			context.stroke();
		}

		function getY(x, lane) {
			const progress = x / _width;
			const envelope = Math.sin(progress * Math.PI) ** 1.3;
			const wave = Math.sin(progress * (11 + intensity * 17) - _phase1 + lane * .58);
			const secondaryWave = Math.sin(progress * 23 + _phase2 + lane * .9) * .25;
			const spread = (lane - CENTER_LANE) * (2.2 + intensity * 1.6);
			const amplitude = (wave + secondaryWave) * (3 + intensity * 13);

			// 高度缩小时同步缩放波幅，避免波峰被裁掉，看起来像线条消失。
			return centerY + (spread + amplitude) * envelope * verticalScale;
		}

		for (let lane = 0; lane < LANE_COUNT; lane++) {
			const distanceFromCenter = Math.abs(lane - CENTER_LANE);
			const reveal = distanceFromCenter <= 2
				? 1
				: clamp(intensity * 3 - (distanceFromCenter - 3), 0, 1);
			const laneWeight = .4 + .6 * smoothstep(reveal);
			const isCenterLane = lane === CENTER_LANE;
			const opacity = (.10 + (lane % 3) * .035 + intensity * .06) * laneWeight;

			context.beginPath();
			for (let x = 0; x <= _width; x += SAMPLE_SPACING) {
				if (x === 0) context.moveTo(x, getY(x, lane));
				else context.lineTo(x, getY(x, lane));
			}
			context.strokeStyle = isCenterLane
				? `rgba(225,185,147,${.5 + intensity * .24})`
				: `rgba(175,160,139,${opacity})`;
			context.lineWidth = isCenterLane ? 1.3 : .8;
			context.stroke();

			// 小粒子沿固定轨迹移动；抵达两端时平滑淡出。
			if (lane % 2 === 0) {
				const progress = (_phase3 + lane * .173) % 1;
				const x = progress * _width;
				const opacity = Math.sin(progress * Math.PI) * .85 * laneWeight;

				context.beginPath();
				context.arc(x, getY(x, lane), lane === 0 ? 1.8 : 1.3, 0, Math.PI * 2);
				context.fillStyle = `rgba(235,207,175,${opacity})`;
				context.fill();
			}
		}

		// 强度参考线。
		const referenceX = margin + intensity * Math.max(0, _width - margin * 2);
		context.setLineDash([2, 4]);
		context.beginPath();
		context.moveTo(referenceX, _height * .12);
		context.lineTo(referenceX, _height * .9);
		context.strokeStyle = '#d9ab8420';
		context.lineWidth = 1;
		context.stroke();
		context.setLineDash([]);
	};

	let lastFrame = 0, lastFrameTime = 0;
	let _visual = 0, _velocity = 0;
	let _visual2 = 0, _velocity2 = 0;

	const onFrame = noAnimation ? AS_IS : now => {
		const delta = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 1 / 30) : 1 / 60;
		lastFrameTime = now;

		const force = (sliderValue - _visual) * 115 - _velocity * 18;
		_velocity += force * delta;
		_visual += _velocity * delta;

		const intensity = clamp(_visual, 0, 1);
		// 使用积分而不是乘以时间避免回放历史
		_phase1 += (1 + intensity * 1.5) * delta;
		_phase2 += .7 * delta;
		_phase3 += (.075 + intensity * .10) * delta;

		input.style.setProperty('--lean', `${clamp(_velocity * 12, -22, 22)}deg`);

		const force2 = (sliderValue - _visual2) * 90 - _velocity2 * 9;
		_velocity2 += force2 * delta * 3;
		_visual2 += _velocity2 * delta * 5;

		input.style.setProperty('--k', String(clamp(_velocity2 * 0.6, -1.03, 1.03)));  // 允许一点点过冲

		drawThinkingTrace(canvas, intensity * 1.75);

		lastFrame = requestAnimationFrame(onFrame);
	};

	const startAnimation = () => {
		if (lastFrame) return;
		onFrame(performance.now());
	}

	const stopAnimation = () => {
		cancelAnimationFrame(lastFrame);
		lastFrame = lastFrameTime = 0;
	}

	// 初始化

	$watchWithCleanup(options, () => {
		if (options.levels != null) {
			input.min = 0;
			input.max = options.levels.length-1;
			input.step = 1;
			uiValue = unconscious(options).value ?? options.levels[0].value;
		} else {
			input.min = options.min;
			input.max = options.max;
			input.step = 128;
			input.value = unconscious(options).value;
			uiValue = input.valueAsNumber;
		}

		levels = options.levels;
		settings = options;

		ticks.replaceChildren();
		labels.replaceChildren();

		if (!levels) {
			for (const value1 of [settings.min, settings.max]) {
				labels.append(<span>{value1}</span>);
				ticks.append(<span/>);
			}
			labels.append(<span className="budget ellipsis" aria-hidden="true" ref={budgetValue}/>);
		} else {
			budgetValue = null;

			const count = levels.length;
			levels.forEach((level, index) => {
				labels.append(
					<button
						className="level ellipsis"
						data-index={index}
						title={level.label}
						hidden={count > 5 && index !== 0 && index !== count - 1}
					>{level.label}</button>
				);
				ticks.append(<span/>);
			});
		}

		updateView(uiValue);
	});

	if(noAnimation) canvas.remove();
	else ro.observe(canvas);
	io.observe(root);
	return root;
}

const levels = [
	{ value: 'minimal', label: '最低', description: '爷不思考了！' },
	{ value: 'low', label: '低', description: '快速判断，保持轻盈。' },
	{ value: 'medium', label: '中', description: '拆解问题，让推理多走一步。' },
	{ value: 'high', label: '高', description: '深入探索，给复杂问题更多空间。' },
	{ value: 'xhigh', label: '超高', description: '雷霆超大思考。' },
	{ value: 'max', label: '超超高', description: '钱包的心电图。' },
	{ value: 'ultra', label: '超超超高', description: '你的额度没了。' },
]

const state = currentCombinedConfig;
const isBudget = $computed(() => state.reasoningEffortPath?.endsWith(",i"));
const token = $derived(state.reasoningBudget);
const level = $derived(state.reasoningEffort);
const supportedEfforts = $derived(state.supportedEfforts);

const options = $computed(() => {
	if (unconscious(isBudget)) {
		return {min: 0, max: unconscious(maxTokensClamped), value: unconscious(token)}
	} else {
		const out = [];
		for (const key of unconscious(supportedEfforts) ?? []) {
			out.push(levels.find(level => level.value === key) ?? { value: key, label: key, description: key });
		}
		return {levels: out.length ? out : levels, value: unconscious(level)}
	}
});

onLoad(() => {
	const el = <ThinkingSlider options={options} onChange={value => {
		if (selectedConversation.presets) {
			const conv = unconscious(selectedConversation);
			const overrides = conv.overrides ??= {};
			if (unconscious(isBudget)) overrides.reasoningBudget = value;
			else overrides.reasoningEffort = value;
			markCombinedPresetDirty(conv);
			updateConversation(conv);
		} else {
			if (unconscious(isBudget)) config.reasoningBudget = value;
			else config.reasoningEffort = value;
			DI_settings.sync(false, true);
		}
	}} />;

	CUSTOM_CONTROLS[0].lastElementChild.append(el);
	el.addEventListener('click', e => {
		e.stopPropagation();
	})

	DI_settings.byId("re").replaceWith(<ThinkingSlider noAnimation={true} options={options} onChange={value => {
		if (unconscious(isBudget)) config.reasoningBudget = value;
		else config.reasoningEffort = value;
		DI_settings.sync(false, true);
	}} />);
});