import {Mp3Recorder} from './Mp3Recorder.js';
import "./Recorder.css";
import {formatSize} from "unconscious/common/Utils.js";
import {$cleanup, $computed, $state, unconscious} from "unconscious";
import {AudioPlayer} from "/src/components/AudioPlayer.jsx";

export const Recorder = ({ onSubmit }) => {
	let statusEl;
	const canvas = <canvas/>;

	const recordState = $state(0);
	const hasRecordData = $computed(() => unconscious(recordState) > 1 ? '' : 'none');
	let recordBlob;

	const elm = <div className="voiceInput">
		<div className="status" ref={statusEl}>点击下方按钮录音</div>
		<div className="viz">{() => unconscious(recordState) > 1 ? <AudioPlayer src={recordBlob}/> : canvas}</div>

		<div className="btns">
			<button className="ri-check-line btn primary" style:display={hasRecordData} title={"接受"} onClick={() => onSubmit(recordBlob)}></button>
			<button className="ri-close-line btn danger" style:display={hasRecordData} title={"重新录制"} onClick={() => recordState.value = 0}></button>
			<button className="ri-circle-fill btn btn-rec"
					title={"录音"}
					style:display={() => unconscious(recordState) < 2 ? '' : 'none'}
					onClick={async ({target: btnRec}) => {
						if (!recorder?._recording) {
							stat('初始化…');
							recorder = new Mp3Recorder({
								bitRate: 64,
								channels: 1,
								sampleRate: 16000,
								onStats([fileSize, encodeMs]) {
									const duration = Date.now() - startMs;
									stat(formatSize(fileSize) + ', CPU: ' + (100 * encodeMs / duration).toFixed(1) + "%");
								},
								onVisualData: drawViz,
							});
							try {
								await recorder.start();
								recordState.value = 1;
							} catch (err) {
								stat('❌ ' + err.message, true);
								console.error(err);
								return
							}

							startMs = Date.now();

							btnRec.classList.remove('ri-circle-fill');
							btnRec.classList.add('ri-square-fill');
						} else {
							btnRec.disabled = true;
							stat('⏳ 结束编码…');
							try {
								recordBlob = await recorder.stop();
								recordBlob = new File([recordBlob], '录音 '+new Date(startMs).toLocaleTimeString()+'.mp3', recordBlob);
								console.log(recordBlob);
								stat(`✅ 完成 · ${formatSize(recordBlob.size)}`);
								recordState.value = 2;
							} catch (err) {
								stat('❌ ' + err.message, true);
								console.error(err);
							} finally {
								recorder.destroy();
								recorder = null;
								btnRec.classList.add('ri-circle-fill');
								btnRec.classList.remove('ri-square-fill');
								btnRec.disabled = false;
							}
						}
					}}></button>
		</div>
	</div>;

	$cleanup(elm, () => {
		console.log("Recorder stopped");
		recorder?.destroy();
		ob.disconnect();
	})

	/**
	 * @type {CanvasRenderingContext2D}
	 */
	const ctx2d = canvas.getContext('2d');
	let recorder = null;
	let startMs = 0;

	/* ── 工具 ── */
	const fmt = ms => {
		const s = Math.floor(ms / 1000);
		return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
	};
	const stat = (m, e) => {
		statusEl.textContent = m;
		statusEl.className = 'status' + (e ? ' err' : '');
	};

	const ob = new ResizeObserver(() => {
		const r = canvas.parentElement?.getBoundingClientRect();
		if (!r) return;
		const dpr = devicePixelRatio;
		canvas.width = r.width * dpr;
		canvas.height = r.height * dpr;
		ctx2d.scale(dpr, dpr);
	});
	ob.observe(elm);

	function drawViz(data) {
		const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
		ctx2d.clearRect(0, 0, canvas.width, canvas.height);
		ctx2d.fillStyle = 'white';
		ctx2d.font = '24px Arial';
		const text = fmt(Date.now() - startMs);
		const width = ctx2d.measureText(text).width;
		ctx2d.fillText(text, (canvas.width - width) / 2 / devicePixelRatio, 28);

		const barW = w / data.length;
		const grad = ctx2d.createLinearGradient(0, 0, 0, h);
		grad.addColorStop(0, '#f78166');
		grad.addColorStop(1, '#0d419d');
		ctx2d.fillStyle = grad;
		for (let i = 0; i < data.length; i++) {
			const bh = (data[i] / 255) * h * 0.9;
			ctx2d.fillRect(i * barW, h - bh, Math.max(barW - 1, 1), bh);
		}
	}
	return elm;
}